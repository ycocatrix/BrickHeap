// SegmentationResult -> Detection mapping (RG_03), whole-image and manual boxes. Pure.
import type { Detection, DetectionId, Point, SegBox, SegmentationResult, Size } from '../types';
import { VISION } from './config';
import { nms } from './geometry';

/** RG_03: NMS on tight boxes (score = areaFrac), keeps at most VISION.maxBoxes (largest), then maps to Detection
 *  (source 'segmentation'), in the segmentation order (top-to-bottom, then left-to-right). `truncated` is true when
 *  boxes were dropped by the cap. */
export function toDetections(seg: SegmentationResult, newId: () => DetectionId): { detections: Detection[]; truncated: boolean } {
  const items = seg.boxes.map((b, index) => ({ box: b.tight, score: b.areaFrac, index, seg: b }));
  const kept = nms(items); // sorted by score desc = largest first
  const truncated = kept.length > VISION.maxBoxes;
  const capped = truncated ? kept.slice(0, VISION.maxBoxes) : kept;
  capped.sort((p, q) => p.index - q.index);
  return { detections: capped.map((it) => fromSegBox(it.seg, newId())), truncated };
}

function fromSegBox(b: SegBox, id: DetectionId): Detection {
  return {
    id,
    box: { ...b.box },
    partial: b.partial,
    suspectMerged: b.suspectMerged,
    source: 'segmentation',
    lab: b.lab,
    rgb: b.rgb,
  };
}

/** box {0,0,1,1}, source 'whole_image'. */
export function wholeImageDetection(id: DetectionId): Detection {
  return {
    id,
    box: { x: 0, y: 0, w: 1, h: 1 },
    partial: false,
    suspectMerged: false,
    source: 'whole_image',
    lab: null,
    rgb: null,
  };
}

function medianOf(values: number[]): number {
  const v = values.slice().sort((a, b) => a - b);
  const n = v.length;
  return n % 2 ? v[n >> 1] : (v[n / 2 - 1] + v[n / 2]) / 2;
}

/** Pixel-square box centred on `center` (normalised); side = median long side (px) of `others` (default 18 % of the
 *  image's short side), capped to the short side, and shifted to stay inside the image. */
export function manualDetection(id: DetectionId, center: Point, image: Size, others: readonly Detection[]): Detection {
  const W = Math.max(1, image.width), H = Math.max(1, image.height);
  const shortSide = Math.min(W, H);
  const longs = others
    .map((d) => Math.max(d.box.w * W, d.box.h * H))
    .filter((v) => Number.isFinite(v) && v > 0);
  let side = longs.length > 0 ? medianOf(longs) : 0.18 * shortSide;
  side = Math.min(shortSide, Math.max(1, side));
  const cx = Math.min(1, Math.max(0, Number.isFinite(center.x) ? center.x : 0.5)) * W;
  const cy = Math.min(1, Math.max(0, Number.isFinite(center.y) ? center.y : 0.5)) * H;
  const left = Math.min(W - side, Math.max(0, cx - side / 2));
  const top = Math.min(H - side, Math.max(0, cy - side / 2));
  return {
    id,
    box: { x: left / W, y: top / H, w: side / W, h: side / H },
    partial: false,
    suspectMerged: false,
    source: 'manual',
    lab: null,
    rgb: null,
  };
}
