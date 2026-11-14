// RG_02: IoU tracker keeping detection ids stable across live snapshots. Pure.
import type { BoundingBox, DetectionId } from '../types';
import { VISION } from './config';
import { iou } from './geometry';

export interface Track { id: DetectionId; box: BoundingBox; hits: number; misses: number }
export interface TrackUpdate {
  tracks: Track[];
  /** track id per input box, same order */
  assigned: DetectionId[];
  removed: DetectionId[];
}

/** Greedy one-to-one matching by descending IoU (≥ VISION.trackIou). Matched: box replaced, hits+1, misses=0.
 *  Unmatched box: new track (hits 1). Unmatched track: misses+1, removed when misses > maxMisses (default 1).
 *  Output tracks: surviving previous tracks in their order, then new tracks in box order. */
export function updateTracks(tracks: readonly Track[], boxes: readonly BoundingBox[], newId: () => DetectionId,
  opts?: { iou?: number; maxMisses?: number }): TrackUpdate {
  const minIou = opts?.iou ?? VISION.trackIou;
  const maxMisses = opts?.maxMisses ?? VISION.live.maxMisses;

  const pairs: { t: number; b: number; v: number }[] = [];
  for (let t = 0; t < tracks.length; t++) {
    for (let b = 0; b < boxes.length; b++) {
      const v = iou(tracks[t].box, boxes[b]);
      if (v >= minIou) pairs.push({ t, b, v });
    }
  }
  pairs.sort((p, q) => q.v - p.v || p.t - q.t || p.b - q.b);

  const trackToBox = new Int32Array(tracks.length).fill(-1);
  const boxToTrack = new Int32Array(boxes.length).fill(-1);
  for (const { t, b } of pairs) {
    if (trackToBox[t] !== -1 || boxToTrack[b] !== -1) continue;
    trackToBox[t] = b;
    boxToTrack[b] = t;
  }

  const out: Track[] = [];
  const removed: DetectionId[] = [];
  const assigned: DetectionId[] = new Array<DetectionId>(boxes.length);
  for (let t = 0; t < tracks.length; t++) {
    const tr = tracks[t];
    const b = trackToBox[t];
    if (b !== -1) {
      out.push({ id: tr.id, box: boxes[b], hits: tr.hits + 1, misses: 0 });
      assigned[b] = tr.id;
    } else if (tr.misses + 1 > maxMisses) {
      removed.push(tr.id);
    } else {
      out.push({ ...tr, misses: tr.misses + 1 });
    }
  }
  for (let b = 0; b < boxes.length; b++) {
    if (boxToTrack[b] !== -1) continue;
    const id = newId();
    out.push({ id, box: boxes[b], hits: 1, misses: 0 });
    assigned[b] = id;
  }
  return { tracks: out, assigned, removed };
}
