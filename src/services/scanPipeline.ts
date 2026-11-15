// Scan orchestration (EX_05, D2, D4, D7). Never rejects: failures are Result values or 'unavailable' pieces.
import type {
  BackgroundQuality, Candidate, CatalogPart, Detection, DetectionId, IdentifiedPiece, Palette, Result, ScanFrame, SegmentationResult,
} from '@/domain/types';
import { err, ok } from '@/domain/result';
import { VISION } from '@/domain/vision/config';
import { segmentPileAsync } from '@/domain/vision/segment';
import { toDetections, wholeImageDetection } from '@/domain/vision/detections';
import { buildPiece, samePart, withPart } from '@/domain/pile/pieces';
import { AMBIGUITY } from '@/domain/pile/thresholds';
import { scan } from '@/i18n/fr/scan';
import { getPalette, resolveCandidates } from './catalog';
import { cropForIdentification, deleteTempFiles, prepareWorkImage, readThumbnailRgba, wholeForIdentification } from './imaging';
import { identifyImageDetailed } from './brickognize';

const yieldToLoop = () => new Promise<void>((r) => setTimeout(r, 0));
const now = () => Date.now();
const CFG_CONCURRENCY = VISION.brickognize.concurrency;

export interface SegmentedPhoto {
  frame: ScanFrame; background: BackgroundQuality; detections: Detection[];
  wholeImage: boolean; truncated: boolean; prepareMs: number; segmentMs: number;
}

async function segmentFrame(frame: ScanFrame, maxSide: number):
  Promise<Result<{ seg: SegmentationResult; thumbMs: number; segMs: number }>> {
  const t0 = now();
  const thumb = await readThumbnailRgba(frame, maxSide);
  if (!thumb.ok) return thumb;
  const t1 = now();
  try {
    const { rgba, width, height } = thumb.value;
    const seg = await segmentPileAsync(rgba, width, height, undefined, yieldToLoop);
    return ok({ seg, thumbMs: t1 - t0, segMs: now() - t1 });
  } catch (e) {
    return err('unknown', scan.segmentFailed, e);
  }
}

/** Capture path: prepareWorkImage(photo, VISION.workMaxSide) → readThumbnailRgba(segMaxSide.inventory) →
 *  segmentPileAsync (yielding) → toDetections. When there is no box or the background is 'patterned':
 *  detections = [wholeImageDetection], wholeImage = true. A re-encoded work image is deleted on failure/abort. */
export async function segmentPhoto(photo: ScanFrame, newId: () => DetectionId, signal?: AbortSignal):
  Promise<Result<SegmentedPhoto>> {
  try {
    const t0 = now();
    const prepared = await prepareWorkImage(photo, VISION.workMaxSide);
    if (!prepared.ok) return prepared;
    const frame = prepared.value;
    const dropWork = async () => { if (frame.uri !== photo.uri) await deleteTempFiles([frame.uri]); };
    const prepMs = now() - t0;
    if (signal?.aborted) { await dropWork(); return err('unknown', scan.cancelled); }
    const r = await segmentFrame(frame, VISION.segMaxSide.inventory);
    if (!r.ok) { await dropWork(); return r; }
    if (signal?.aborted) { await dropWork(); return err('unknown', scan.cancelled); }
    const { seg, thumbMs, segMs } = r.value;
    const background = seg.background.quality;
    const base = { frame, background, prepareMs: prepMs + thumbMs, segmentMs: segMs };
    if (background === 'patterned' || seg.boxes.length === 0) {
      return ok({ ...base, detections: [wholeImageDetection(newId())], wholeImage: true, truncated: false });
    }
    const { detections, truncated } = toDetections(seg, newId);
    if (detections.length === 0) {
      return ok({ ...base, detections: [wholeImageDetection(newId())], wholeImage: true, truncated: false });
    }
    return ok({ ...base, detections, wholeImage: false, truncated });
  } catch (e) {
    return err('unknown', scan.segmentFailed, e);
  }
}

/** Live path: frame = photo (no re-encode) → readThumbnailRgba(segMaxSide) → segmentPileAsync → raw boxes
 *  (no whole-image fallback; tracking is done by the store). `ms` = thumbnail + segmentation. */
export async function segmentLive(photo: ScanFrame, segMaxSide: number):
  Promise<Result<{ seg: SegmentationResult; ms: number }>> {
  try {
    const r = await segmentFrame(photo, segMaxSide);
    if (!r.ok) return r;
    return ok({ seg: r.value.seg, ms: r.value.thumbMs + r.value.segMs });
  } catch (e) {
    return err('unknown', scan.segmentFailed, e);
  }
}

async function safePalette(): Promise<Palette | null> {
  try {
    return await getPalette();
  } catch {
    return null;
  }
}

/** Runs `worker` over `items` with at most `size` in flight. */
async function pool<T>(items: readonly T[], size: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
}

async function identifyOne(frame: ScanFrame, det: Detection, palette: Palette | null, signal: AbortSignal | undefined,
  count: () => void): Promise<IdentifiedPiece | null> {
  const crop = det.source === 'whole_image'
    ? await wholeForIdentification(frame)
    : await cropForIdentification(frame, det.box);
  if (!crop.ok) {
    // Too small → 'empty' with error 'invalid' (grey box « trop petite », not retryable); other crop errors are
    // retryable ('unavailable').
    const tooSmall = crop.error.code === 'invalid';
    return buildPiece(det, {
      status: tooSmall ? 'empty' : 'unavailable', candidates: [], colors: [], boxScore: 0,
      error: tooSmall ? 'invalid' : 'unknown',
    }, palette, null);
  }
  if (signal?.aborted) { await deleteTempFiles([crop.value.uri]); return null; }
  count();
  const { identification, box } = await identifyImageDetailed(crop.value.uri, signal);
  if (signal?.aborted) { await deleteTempFiles([crop.value.uri]); return null; }
  const detection = det.source === 'whole_image' && box && identification.boxScore >= AMBIGUITY.minBoxScore
    ? { ...det, box }
    : det;
  return buildPiece(detection, identification, palette, crop.value.uri);
}

/** For each detection: crop from `frame` → identifyImage (pool of VISION.brickognize.concurrency) → fuseColor →
 *  part = provisionalPart(top candidate) (D7, immediate) → evaluatePiece → onPiece (cropUri set).
 *  Then ONE catalog.resolveCandidates() call for all distinct chosen candidates → resolved parts swapped in →
 *  onPiece again. Whole-image detections: the box is replaced by Brickognize's bounding_box when boxScore ≥ 0.5.
 *  After `signal` aborts, no onPiece is called and in-flight requests are cancelled.
 *  Writes nothing but the catalogue cache (through resolveCandidates). */
export async function identifyDetections(frame: ScanFrame, detections: readonly Detection[], opts: { signal?: AbortSignal;
  onPiece: (piece: IdentifiedPiece) => void }): Promise<{ pieces: IdentifiedPiece[]; identifyMs: number; catalogMs: number; calls: number }> {
  const { signal, onPiece } = opts;
  const emit = (p: IdentifiedPiece) => {
    if (signal?.aborted) return;
    try {
      onPiece(p);
    } catch {
      // a listener error must not break the pipeline
    }
  };
  const t0 = now();
  let calls = 0;
  const results: (IdentifiedPiece | null)[] = detections.map(() => null);
  const palette = await safePalette();

  await pool(detections, CFG_CONCURRENCY, async (det, i) => {
    if (signal?.aborted) return;
    try {
      const piece = await identifyOne(frame, det, palette, signal, () => { calls += 1; });
      if (!piece) return;
      results[i] = piece;
      emit(piece);
    } catch {
      // never rejects
    }
  });
  const identifyMs = now() - t0;
  const pieces = results.filter((p): p is IdentifiedPiece => p !== null);
  if (signal?.aborted) return { pieces, identifyMs, catalogMs: 0, calls };

  const t1 = now();
  const chosen = new Map<string, Candidate>();
  for (const p of pieces) {
    const c = p.chosen >= 0 ? p.identification.candidates[p.chosen] : undefined;
    if (c && !chosen.has(c.bricklinkId)) chosen.set(c.bricklinkId, c);
  }
  if (chosen.size > 0) {
    let resolved: Map<string, CatalogPart> | null = null;
    try {
      resolved = await resolveCandidates([...chosen.values()]);
    } catch {
      resolved = null;                                     // provisional parts stay
    }
    if (resolved && !signal?.aborted) {
      for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i];
        const c = p.chosen >= 0 ? p.identification.candidates[p.chosen] : undefined;
        const part = c ? resolved.get(c.bricklinkId) : undefined;
        if (part && !samePart(part, p.part)) {
          pieces[i] = withPart(p, part);
          emit(pieces[i]);
        }
      }
    }
  }
  return { pieces, identifyMs, catalogMs: now() - t1, calls };
}

