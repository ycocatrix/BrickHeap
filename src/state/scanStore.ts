// Scan session shared by ScannerScreen, ReviewScreen, PartScreen and CalibrationScreen (§4.5).
// Never throws for expected failures; every async action resolves.
import type {
  Candidate, CatalogPart, Detection, DetectionId, IdentifiedPiece, ListId, Point, Result, ReviewState, ScanFrame,
  ScanMode, ScanNotice, ScanResult, Size,
} from '@/domain/types';
import { err, ok, toAppError } from '@/domain/result';
import { itemKey } from '@/domain/keys';
import { VISION } from '@/domain/vision/config';
import { orientationMatches } from '@/domain/vision/geometry';
import { toDetections, manualDetection } from '@/domain/vision/detections';
import { updateTracks, type Track } from '@/domain/vision/tracker';
import { provisionalPart } from '@/domain/catalog/partInfo';
import { groupPieces } from '@/domain/pile/grouping';
import { markPending, pendingPiece } from '@/domain/pile/pieces';
import {
  chooseCandidate as chooseInReview, createReview, reviewSummary, toDeltas,
} from '@/domain/pile/review';
import { scan } from '@/i18n/fr/scan';
import { identifyDetections, segmentLive, segmentPhoto } from '@/services/scanPipeline';
import { deleteTempFiles } from '@/services/imaging';
import { resolveCandidates } from '@/services/catalog';
import { applyDeltas, setLastListId } from '@/data/inventoryRepo';
import { createStore, type Store } from './createStore';

export interface ScanState {
  /** New id at every capture / freeze / resume; results carrying an older id are dropped. */
  scanId: string;
  mode: ScanMode;
  /** live: camera preview (+ boxes of the last snapshot) · analyzing: capture being prepared/segmented (no box
   *  yet) · frozen: still shown; entered as soon as boxes exist, identification continues progressively */
  phase: 'live' | 'analyzing' | 'frozen';
  /** Image the boxes refer to (live snapshot or capture); null before the first snapshot. */
  frame: ScanFrame | null;
  pieces: IdentifiedPiece[];
  selectedId: DetectionId | null;
  notice: ScanNotice | null;
  /** false after the automatic fallback (D9), until the next app start. */
  liveOk: boolean;
  review: ReviewState | null;
  /** Last completed Inventorier capture, kept for Calibration (EX_10). */
  lastResult: ScanResult | null;
  /** itemKey → quantity added since app start (RG_09). */
  sessionAdded: Record<string, number>;
}

export const scanStore: Store<ScanState> = createStore<ScanState>({
  scanId: 's0',
  mode: 'explore',
  phase: 'live',
  frame: null,
  pieces: [],
  selectedId: null,
  notice: null,
  liveOk: true,
  review: null,
  lastResult: null,
  sessionAdded: {},
});

// ---------- internal session state (not rendered) ----------
let idSeq = 0;
let scanSeq = 0;
const newDetectionId = (): DetectionId => `d${++idSeq}`;
const newScanId = (): string => `s${++scanSeq}`;
/** Bumped by capture() and resume(): work started under an older epoch is dropped (freeze keeps the epoch so the
 *  identifications of the frozen snapshot keep landing). */
let epoch = 0;
let abortCtl = new AbortController();
/** Live tracker state (RG_02). */
let tracks: Track[] = [];
/** Detection ids with a Brickognize request in flight. */
const inFlight = new Set<DetectionId>();
/** Identified pieces of live tracks, kept while the track lives (a track missed once keeps its identification). */
const liveCache = new Map<DetectionId, IdentifiedPiece>();
/** Temp-file holds: a photo used by in-flight crops is deleted only once released. */
const holds = new Map<string, number>();
const doomed = new Set<string>();

const get = () => scanStore.get();
const set = (patch: Partial<ScanState>) => scanStore.set(patch);

function retain(uri: string): void {
  holds.set(uri, (holds.get(uri) ?? 0) + 1);
}
function release(uri: string): void {
  const n = (holds.get(uri) ?? 1) - 1;
  if (n > 0) { holds.set(uri, n); return; }
  holds.delete(uri);
  if (doomed.delete(uri)) void deleteTempFiles([uri]);
}
/** Deletes a temp file now, or when its last hold is released. */
function discard(uri: string | null | undefined): void {
  if (!uri) return;
  if (holds.has(uri)) doomed.add(uri);
  else void deleteTempFiles([uri]);
}

function isCropReferenced(uri: string): boolean {
  const s = get();
  const uses = (ps: readonly IdentifiedPiece[] | undefined) => !!ps?.some((p) => p.cropUri === uri);
  return uses(s.pieces) || uses(s.review?.pieces) || uses([...liveCache.values()]);
}
function discardCrop(uri: string | null | undefined): void {
  if (uri && !isCropReferenced(uri)) discard(uri);
}

const hasUnavailable = (ps: readonly IdentifiedPiece[]) => ps.some((p) => p.identification.status === 'unavailable');

/** EX_09 notice from the current pieces, keeping a non-identification notice. */
function refreshNotice(): void {
  const s = get();
  if (hasUnavailable(s.pieces)) {
    if (s.notice !== 'identification_unavailable') set({ notice: 'identification_unavailable' });
  } else if (s.notice === 'identification_unavailable') {
    set({ notice: null });
  }
}

/** Lands one Brickognize/catalogue result for the current epoch. */
function applyIdentified(ep: number, piece: IdentifiedPiece): void {
  if (ep !== epoch) { discard(piece.cropUri); return; }
  const id = piece.detection.id;
  const s = get();
  const idx = s.pieces.findIndex((p) => p.detection.id === id);
  const live = tracks.some((t) => t.id === id);
  if (idx < 0) {
    if (live) {
      const old = liveCache.get(id);
      liveCache.set(id, piece);
      if (old && old.cropUri !== piece.cropUri) discardCrop(old.cropUri);
    } else {
      discardCrop(piece.cropUri);
    }
    return;
  }
  const current = s.pieces[idx];
  let next: IdentifiedPiece;
  if (current.partConfirmed) {
    // The user already chose: keep the choice, only take the crop when none exists yet.
    next = current.cropUri ? current : { ...current, cropUri: piece.cropUri };
  } else {
    next = { ...piece, detection: current.detection.source === 'whole_image' ? piece.detection : current.detection,
      partialConfirmed: current.partialConfirmed };
  }
  const pieces = s.pieces.slice();
  pieces[idx] = next;
  if (live) liveCache.set(id, next);
  set({ pieces });
  if (current.cropUri && current.cropUri !== next.cropUri) discardCrop(current.cropUri);
  if (piece.cropUri && piece.cropUri !== next.cropUri) discardCrop(piece.cropUri);
}

/** Identifies `dets` on `frame` (skipping ids already in flight), landing results progressively. */
async function runIdentification(dets: readonly Detection[], frame: ScanFrame):
  Promise<Awaited<ReturnType<typeof identifyDetections>> | null> {
  const todo = dets.filter((d) => !inFlight.has(d.id));
  if (todo.length === 0) return null;
  const ep = epoch;
  const signal = abortCtl.signal;
  for (const d of todo) inFlight.add(d.id);
  retain(frame.uri);
  try {
    const out = await identifyDetections(frame, todo, { signal, onPiece: (p) => applyIdentified(ep, p) });
    return ep === epoch ? out : null;
  } catch {
    return null;
  } finally {
    for (const d of todo) inFlight.delete(d.id);
    release(frame.uri);
    if (ep === epoch) refreshNotice();
  }
}

/** Aborts everything in flight and frees the session's temp files (frame, crops). */
function newEpoch(): void {
  abortCtl.abort();
  abortCtl = new AbortController();
  epoch += 1;
  const s = get();
  const crops = [...s.pieces, ...(s.review?.pieces ?? []), ...liveCache.values()].map((p) => p.cropUri);
  liveCache.clear();
  tracks = [];
  inFlight.clear();
  discard(s.frame?.uri);
  for (const c of new Set(crops)) discard(c);
}

function safeOrientation(photo: Size, view: Size): boolean {
  try {
    return orientationMatches(photo, view);
  } catch {
    return true;
  }
}

function liveNotice(count: number, truncated: boolean, pieces: readonly IdentifiedPiece[]): ScanNotice | null {
  if (truncated) return 'too_many';
  if (count === 0) return 'no_piece';
  if (hasUnavailable(pieces)) return 'identification_unavailable';
  return null;
}

type IngestOutcome = 'ok' | 'skipped' | 'failed';

export const scanActions: {
  setMode(mode: ScanMode): void;
  ingestLiveSnapshot(photo: ScanFrame, viewSize: Size, segMaxSide: number): Promise<IngestOutcome>;
  capture(photo: ScanFrame): Promise<void>;
  freeze(selectId?: DetectionId): void;
  resume(): void;
  reportLiveFailure(): void;
  retryUnavailable(): Promise<void>;
  addManualBox(point: Point): Promise<void>;
  removePiece(id: DetectionId): void;
  select(id: DetectionId | null): void;
  chooseCandidate(target: { detectionId: DetectionId } | { groupKey: string }, candidate: Candidate): Promise<void>;
  startReview(): void;
  updateReview(fn: (s: ReviewState) => ReviewState): void;
  commitReview(listId: ListId): Promise<Result<{ added: number; skipped: number; undo: () => Promise<void> }>>;
} = {
  setMode(mode) {
    if (get().mode !== mode) set({ mode });
  },

  async ingestLiveSnapshot(photo, viewSize, segMaxSide) {
    try {
      if (get().phase !== 'live' || !safeOrientation(photo, viewSize)) { discard(photo.uri); return 'skipped'; }
      const ep = epoch;
      const r = await segmentLive(photo, segMaxSide);
      if (ep !== epoch || get().phase !== 'live') { discard(photo.uri); return 'skipped'; }
      if (!r.ok) { discard(photo.uri); return 'failed'; }
      const { seg } = r.value;
      if (seg.background.quality === 'patterned') {
        // Deviation (reported): the boxes are left untouched but the notice tells the user why nothing is drawn.
        discard(photo.uri);
        if (get().notice !== 'patterned_background') set({ notice: 'patterned_background' });
        return 'skipped';
      }

      const { detections, truncated } = toDetections(seg, newDetectionId);
      const upd = updateTracks(tracks, detections.map((d) => d.box), newDetectionId,
        { iou: VISION.trackIou, maxMisses: VISION.live.maxMisses });
      tracks = upd.tracks;
      const hits = new Map(tracks.map((t) => [t.id, t.hits]));
      const dets = detections.map((d, i) => ({ ...d, id: upd.assigned[i] }));
      const removedCrops: (string | null)[] = [];
      for (const id of upd.removed) {
        removedCrops.push(liveCache.get(id)?.cropUri ?? null);
        liveCache.delete(id);
      }
      const pieces = dets.map((d) => {
        const cached = liveCache.get(d.id);
        return cached ? { ...cached, detection: d } : pendingPiece(d);
      });

      const s = get();
      const prev = s.frame;
      const selectedId = s.selectedId && pieces.some((p) => p.detection.id === s.selectedId) ? s.selectedId : null;
      set({ frame: photo, pieces, selectedId, notice: liveNotice(dets.length, truncated, pieces) });
      if (prev && prev.uri !== photo.uri) discard(prev.uri);
      for (const c of removedCrops) discardCrop(c);

      if (s.mode === 'explore') {
        const stable = pieces
          .filter((p) => (hits.get(p.detection.id) ?? 0) >= VISION.live.stableHits
            && p.identification.status === 'pending' && !inFlight.has(p.detection.id))
          .map((p) => p.detection);
        if (stable.length > 0) void runIdentification(stable, photo);
      }
      return 'ok';
    } catch {
      discard(photo.uri);
      return 'failed';
    }
  },

  async capture(photo) {
    const tStart = Date.now();
    const mode = get().mode;
    newEpoch();
    const ep = epoch;
    const signal = abortCtl.signal;
    const scanId = newScanId();
    set({ scanId, phase: 'analyzing', frame: photo, pieces: [], selectedId: null, notice: null, review: null });
    retain(photo.uri);
    let seg: Awaited<ReturnType<typeof segmentPhoto>>;
    try {
      seg = await segmentPhoto(photo, newDetectionId, signal);
    } catch (e) {
      seg = err('unknown', scan.segmentFailed, e);
    } finally {
      release(photo.uri);
    }
    if (ep !== epoch) {
      if (seg.ok && seg.value.frame.uri !== photo.uri) discard(seg.value.frame.uri);
      discard(photo.uri);
      return;
    }
    if (!seg.ok) {
      discard(photo.uri);
      set({ phase: 'live', frame: null, pieces: [], notice: 'no_piece' });
      return;
    }
    const sp = seg.value;
    if (sp.frame.uri !== photo.uri) discard(photo.uri);
    set({
      phase: 'frozen',
      frame: sp.frame,
      pieces: sp.detections.map(pendingPiece),
      notice: sp.background === 'patterned' ? 'patterned_background' : sp.truncated ? 'too_many' : null,
    });
    const out = await runIdentification(sp.detections, sp.frame);
    if (ep !== epoch || !out || mode !== 'inventory') return;
    const result: ScanResult = {
      id: scanId,
      mode,
      frame: sp.frame,
      background: sp.background,
      wholeImage: sp.wholeImage,
      pieces: out.pieces,
      timings: {
        prepareMs: sp.prepareMs,
        segmentMs: sp.segmentMs,
        identifyMs: out.identifyMs,
        catalogMs: out.catalogMs,
        totalMs: Date.now() - tStart,
        brickognizeCalls: out.calls,
      },
    };
    set({ lastResult: result });
  },

  freeze(selectId) {
    const s = get();
    if (s.phase !== 'live' || !s.frame) {
      if (selectId !== undefined) set({ selectedId: selectId });
      return;
    }
    set({ scanId: newScanId(), phase: 'frozen', selectedId: selectId ?? null });
    if (selectId === undefined) return;
    const p = s.pieces.find((x) => x.detection.id === selectId);
    if (p && p.identification.status === 'pending' && !inFlight.has(selectId)) {
      void runIdentification([p.detection], s.frame);
    }
  },

  resume() {
    newEpoch();
    set({ scanId: newScanId(), phase: 'live', frame: null, pieces: [], selectedId: null, notice: null, review: null });
  },

  reportLiveFailure() {
    set({ liveOk: false, notice: 'live_unavailable' });
  },

  async retryUnavailable() {
    const s = get();
    if (!s.frame) return;
    const targets = s.pieces.filter((p) => p.identification.status === 'unavailable'
      || (p.identification.status === 'pending' && !inFlight.has(p.detection.id)));
    if (targets.length === 0) return;
    const ids = new Set(targets.map((p) => p.detection.id));
    for (const id of ids) liveCache.delete(id);
    set({
      pieces: s.pieces.map((p) => (ids.has(p.detection.id) ? markPending(p) : p)),
      notice: s.notice === 'identification_unavailable' ? null : s.notice,
    });
    await runIdentification(targets.map((p) => p.detection), s.frame);
  },

  async addManualBox(point) {
    const s = get();
    if (s.phase !== 'frozen' || !s.frame) return;
    let det: Detection;
    try {
      det = manualDetection(newDetectionId(), point, s.frame, s.pieces.map((p) => p.detection));
    } catch {
      return;
    }
    set({ pieces: [...s.pieces, pendingPiece(det)], selectedId: det.id });
    await runIdentification([det], s.frame);
  },

  removePiece(id) {
    const s = get();
    const piece = s.pieces.find((p) => p.detection.id === id);
    if (!piece) return;
    liveCache.delete(id);
    set({ pieces: s.pieces.filter((p) => p !== piece), selectedId: s.selectedId === id ? null : s.selectedId });
    discardCrop(piece.cropUri);
  },

  select(id) {
    if (get().selectedId !== id) set({ selectedId: id });
  },

  async chooseCandidate(target, candidate) {
    const ep = epoch;
    const s = get();
    const source = s.review ? s.review.pieces : s.pieces;
    const ids = 'detectionId' in target
      ? [target.detectionId]
      : groupPieces(source).find((g) => g.key === target.groupKey)?.detectionIds ?? [];
    if (ids.length === 0) return;
    let part: CatalogPart;
    try {
      const resolved = await resolveCandidates([candidate]);
      part = resolved.get(candidate.bricklinkId) ?? provisionalPart(candidate, 'pending');
    } catch {
      part = provisionalPart(candidate, 'pending');
    }
    if (ep !== epoch) return;
    const cur = get();
    if (cur.review) {
      set({ review: chooseInReview(cur.review, ids, candidate, part) });
      return;
    }
    const pieces = chooseInReview(createReview(cur.pieces), ids, candidate, part).pieces;
    for (const p of pieces) if (ids.includes(p.detection.id) && liveCache.has(p.detection.id)) liveCache.set(p.detection.id, p);
    set({ pieces });
  },

  startReview() {
    set({ review: createReview(get().pieces) });
  },

  updateReview(fn) {
    const review = get().review;
    if (review) set({ review: fn(review) });
  },

  async commitReview(listId) {
    const review = get().review;
    if (!review) return err('invalid', scan.noReview);
    const summary = reviewSummary(review);
    if (!summary.canAdd) return err('invalid', summary.colorToConfirm > 0 ? scan.colorToConfirm : scan.nothingToAdd);
    const deltas = toDeltas(review, listId);
    if (deltas.length === 0) return err('invalid', scan.nothingToAdd);

    let applied: Awaited<ReturnType<typeof applyDeltas>>;
    try {
      applied = await applyDeltas(deltas);
    } catch (e) {
      return err(toAppError(e).code, scan.addFailed, e);
    }
    try {
      await setLastListId(listId);
    } catch {
      // the list choice is a convenience (EX_07)
    }

    const addedByKey: Record<string, number> = {};
    let added = 0;
    for (const d of applied.applied) {
      if (d.delta <= 0) continue;
      const k = itemKey(d.partId, d.colorId);
      addedByKey[k] = (addedByKey[k] ?? 0) + d.delta;
      added += d.delta;
    }
    const bump = (sign: 1 | -1) => {
      const next = { ...get().sessionAdded };
      for (const [k, n] of Object.entries(addedByKey)) {
        const v = (next[k] ?? 0) + sign * n;
        if (v > 0) next[k] = v;
        else delete next[k];
      }
      set({ sessionAdded: next });
    };
    bump(1);
    set({ review: null });
    scanActions.resume();

    let undone = false;
    const undo = async (): Promise<void> => {
      if (undone) return;
      undone = true;
      try {
        await applyDeltas(applied.inverse);
        bump(-1);
      } catch {
        undone = false;                                    // can be retried; never rejects
      }
    };
    return ok({ added, skipped: summary.unknown + summary.partial, undo });
  },
};
