// Test fixtures for WP3 (not a test file). Pure: types only, no React Native.
import type {
  BoundingBox, Candidate, CatalogColor, CatalogPart, ColorCandidate, Detection, IdentifiedPiece, Palette, Point,
  SegmentationResult, Size,
} from '../../types';

/** Same shape as src/domain/vision/tracker Track (declared here so this file needs no WP2 import). */
interface Track { id: string; box: BoundingBox; hits: number; misses: number }

export function cand(bricklinkId: string, rawScore: number, confidence = rawScore): Candidate {
  return { bricklinkId, name: `Part ${bricklinkId}`, imageUrl: `https://img/${bricklinkId}.png`, category: null,
    rawScore, confidence };
}

export function part(partId: string, source: CatalogPart['source'] = 'rebrickable', name = `Part ${partId}`): CatalogPart {
  return {
    partId, name, categoryId: null, imageUrl: `https://img/${partId}.png`, bricklinkIds: [partId], legoIds: [],
    printOf: null, yearFrom: null, yearTo: null, source,
    resolution: source === 'rebrickable' ? 'resolved' : 'pending',
  };
}

export function detection(id: string, x = 0.1, y = 0.1, extra: Partial<Detection> = {}): Detection {
  return { id, box: { x, y, w: 0.1, h: 0.1 }, partial: false, suspectMerged: false, source: 'segmentation',
    lab: null, rgb: null, ...extra };
}

export interface PieceOpts {
  id: string;
  partId?: string | null;
  partSource?: CatalogPart['source'];
  name?: string;
  colorId?: number | null;
  reliable?: boolean;
  confidence?: number;
  level?: IdentifiedPiece['level'];
  partial?: boolean;
  partialConfirmed?: boolean;
  partConfirmed?: boolean;
  x?: number;
  y?: number;
  cropUri?: string | null;
  candidates?: Candidate[];
  status?: IdentifiedPiece['identification']['status'];
}

/** A piece with sensible defaults: identified, accepted (0.9), reliable colour. */
export function piece(o: PieceOpts): IdentifiedPiece {
  const partId = o.partId === undefined ? '3001' : o.partId;
  const p = partId === null ? null : part(partId, o.partSource ?? 'rebrickable', o.name ?? `Part ${partId}`);
  const confidence = o.confidence ?? 0.9;
  const level = o.level ?? (confidence >= 0.8 ? 'accepted' : confidence >= 0.5 ? 'review' : 'unknown');
  const candidates = o.candidates ?? (partId === null ? [] : [cand(partId, confidence)]);
  return {
    detection: detection(o.id, o.x ?? 0.1, o.y ?? 0.1, { partial: o.partial ?? false }),
    identification: { status: o.status ?? (candidates.length ? 'identified' : 'empty'), candidates, colors: [],
      boxScore: 0.9, error: null },
    chosen: candidates.length ? 0 : -1,
    part: p,
    color: { colorId: o.colorId === undefined ? 4 : o.colorId, reliable: o.reliable ?? true, source: 'brickognize',
      alternatives: [] },
    confidence,
    level,
    partConfirmed: o.partConfirmed ?? false,
    partialConfirmed: o.partialConfirmed ?? false,
    cropUri: o.cropUri === undefined ? `file:///crop-${o.id}.jpg` : o.cropUri,
  };
}

export function color(colorId: number, bricklinkId: number | null, isTrans = false, hex = '000000'): CatalogColor {
  return { colorId, name: `Color ${colorId}`, hex, isTrans, bricklinkId };
}

export function palette(colors: CatalogColor[]): Palette {
  const byBricklinkId = new Map<number, CatalogColor>();
  for (const c of [...colors].sort((a, b) => a.colorId - b.colorId)) {
    if (c.bricklinkId !== null && !byBricklinkId.has(c.bricklinkId)) byBricklinkId.set(c.bricklinkId, c);
  }
  return { colors, categories: [], byId: new Map(colors.map((c) => [c.colorId, c])), byBricklinkId,
    categoryName: new Map() };
}

export const bkColor = (bricklinkColorId: number, score: number): ColorCandidate =>
  ({ bricklinkColorId, name: `BL ${bricklinkColorId}`, score });

const iouOf = (a: BoundingBox, b: BoundingBox) => {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
};

/** Minimal stand-ins for the WP2 modules used by the scan store, so WP3 tests do not depend on WP2's progress. */
export const visionMock = {
  tracker: {
    updateTracks(tracks: readonly Track[], boxes: readonly BoundingBox[], newId: () => string,
      opts?: { iou?: number; maxMisses?: number }) {
      const used = new Set<string>();
      const next: Track[] = [];
      const assigned = boxes.map((box) => {
        const match = tracks.find((t) => !used.has(t.id) && iouOf(t.box, box) >= (opts?.iou ?? 0.5));
        if (match) { used.add(match.id); next.push({ id: match.id, box, hits: match.hits + 1, misses: 0 }); return match.id; }
        const id = newId();
        next.push({ id, box, hits: 1, misses: 0 });
        return id;
      });
      const removed: string[] = [];
      for (const t of tracks) {
        if (used.has(t.id)) continue;
        if (t.misses + 1 > (opts?.maxMisses ?? 1)) removed.push(t.id);
        else next.push({ ...t, misses: t.misses + 1 });
      }
      return { tracks: next, assigned, removed };
    },
  },
  geometry: {
    orientationMatches: (a: Size, b: Size) => (a.width >= a.height) === (b.width >= b.height),
    boxToPixelRect: (b: BoundingBox, s: Size) => ({ originX: Math.round(b.x * s.width), originY: Math.round(b.y * s.height),
      width: Math.max(1, Math.round(b.w * s.width)), height: Math.max(1, Math.round(b.h * s.height)) }),
  },
  detections: {
    toDetections: (seg: SegmentationResult, newId: () => string) => ({
      detections: seg.boxes.map((b): Detection => ({ id: newId(), box: b.box, partial: b.partial,
        suspectMerged: b.suspectMerged, source: 'segmentation', lab: b.lab, rgb: b.rgb })),
      truncated: false,
    }),
    wholeImageDetection: (id: string): Detection => ({ id, box: { x: 0, y: 0, w: 1, h: 1 }, partial: false,
      suspectMerged: false, source: 'whole_image', lab: null, rgb: null }),
    manualDetection: (id: string, c: Point): Detection => ({ id, box: { x: c.x - 0.05, y: c.y - 0.05, w: 0.1, h: 0.1 },
      partial: false, suspectMerged: false, source: 'manual', lab: null, rgb: null }),
  },
};

/** A segmentation result with one plain-background box per given box. */
export function segResult(boxes: BoundingBox[], quality: SegmentationResult['background']['quality'] = 'plain'):
  SegmentationResult {
  return {
    boxes: boxes.map((box) => ({ box, tight: box, areaFrac: box.w * box.h, partial: false, fromSplit: false,
      suspectMerged: false, lab: [50, 0, 0] as const, rgb: [120, 120, 120] as const })),
    background: { quality, sigmaL: 1, sigmaC: 1 },
    width: 320, height: 240, ms: 1,
  };
}

/** Replacement for src/domain/catalog/partInfo (WP5) in WP3 tests: identity label, D7 provisional part. */
export const partInfoMock = {
  partLabel: (name: string) => name,
  provisionalPart: (c: Pick<Candidate, 'bricklinkId' | 'name' | 'imageUrl'>, resolution: 'pending' | 'not_found'):
    CatalogPart => ({
    partId: c.bricklinkId, name: c.name, categoryId: null, imageUrl: c.imageUrl, bricklinkIds: [c.bricklinkId],
    legoIds: [], printOf: null, yearFrom: null, yearTo: null, source: 'brickognize', resolution,
  }),
};
