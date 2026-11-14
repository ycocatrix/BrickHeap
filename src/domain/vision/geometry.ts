// Box geometry, view mapping and camera-size helpers. Pure.
import type { BoundingBox, DetectionId, PixelRect, Point, Size } from '../types';
import { VISION } from './config';

function clamp01(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0; // NaN -> 0
}

function area(b: BoundingBox): number {
  return b.w > 0 && b.h > 0 ? b.w * b.h : 0;
}

/** Intersection over union; 0 when disjoint or degenerate. */
export function iou(a: BoundingBox, b: BoundingBox): number {
  const aa = area(a), ab = area(b);
  if (aa === 0 || ab === 0) return 0;
  const iw = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const ih = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (!(iw > 0) || !(ih > 0)) return 0;
  const inter = iw * ih;
  return inter / (aa + ab - inter);
}

/** Greedy NMS: sort by score desc, drop any item whose IoU with a kept item is > threshold (default VISION.nmsIou). */
export function nms<T extends { box: BoundingBox; score: number }>(items: readonly T[], iouThreshold: number = VISION.nmsIou): T[] {
  const order = items.map((_, i) => i).sort((i, j) => items[j].score - items[i].score || i - j);
  const kept: T[] = [];
  for (const i of order) {
    const it = items[i];
    let drop = false;
    for (const k of kept) {
      if (iou(it.box, k.box) > iouThreshold) { drop = true; break; }
    }
    if (!drop) kept.push(it);
  }
  return kept;
}

/** Inside [0,1], w/h ≥ 0. */
export function clampBox(b: BoundingBox): BoundingBox {
  const x0 = clamp01(b.x), y0 = clamp01(b.y);
  const x1 = clamp01(b.x + b.w), y1 = clamp01(b.y + b.h);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** Integers, ≥ 1 px, inside the image. */
export function boxToPixelRect(b: BoundingBox, image: Size): PixelRect {
  const W = Math.max(1, Math.round(image.width));
  const H = Math.max(1, Math.round(image.height));
  const c = clampBox(b);
  const x0 = Math.min(W - 1, Math.max(0, Math.floor(c.x * W + 1e-9)));
  const y0 = Math.min(H - 1, Math.max(0, Math.floor(c.y * H + 1e-9)));
  const x1 = Math.min(W, Math.max(x0 + 1, Math.ceil((c.x + c.w) * W - 1e-9)));
  const y1 = Math.min(H, Math.max(y0 + 1, Math.ceil((c.y + c.h) * H - 1e-9)));
  return { originX: x0, originY: y0, width: x1 - x0, height: y1 - y0 };
}

/** Keeps aspect, never upscales, integers (each side ≥ 1). */
export function fitWithin(size: Size, maxSide: number): Size {
  const w = Math.max(1, Math.round(size.width));
  const h = Math.max(1, Math.round(size.height));
  const long = Math.max(w, h);
  if (long <= maxSide) return { width: w, height: h };
  const s = maxSide / long;
  return w >= h
    ? { width: Math.round(maxSide), height: Math.max(1, Math.round(h * s)) }
    : { width: Math.max(1, Math.round(w * s)), height: Math.round(maxSide) };
}

export interface ViewTransform { scale: number; dx: number; dy: number }

function centred(image: Size, view: Size, scale: number): ViewTransform {
  return { scale, dx: (view.width - image.width * scale) / 2, dy: (view.height - image.height * scale) / 2 };
}

/** Live preview (aspect-fill): s = max(vw/iw, vh/ih), centred. */
export function coverTransform(image: Size, view: Size): ViewTransform {
  return centred(image, view, Math.max(view.width / image.width, view.height / image.height));
}

/** Frozen still (aspect-fit): s = min(vw/iw, vh/ih), centred. */
export function containTransform(image: Size, view: Size): ViewTransform {
  return centred(image, view, Math.min(view.width / image.width, view.height / image.height));
}

/** Normalised box -> view coordinates (points). */
export function boxToView(b: BoundingBox, image: Size, t: ViewTransform): { left: number; top: number; width: number; height: number } {
  return {
    left: b.x * image.width * t.scale + t.dx,
    top: b.y * image.height * t.scale + t.dy,
    width: b.w * image.width * t.scale,
    height: b.h * image.height * t.scale,
  };
}

/** View point -> normalised image point; null outside the image. */
export function viewToImagePoint(p: Point, image: Size, t: ViewTransform): Point | null {
  if (!(t.scale > 0) || !(image.width > 0) || !(image.height > 0)) return null;
  const x = (p.x - t.dx) / t.scale / image.width;
  const y = (p.y - t.dy) / t.scale / image.height;
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;
  return { x, y };
}

/** Smallest box containing the normalised point, else null. */
export function hitTest(p: Point, boxes: readonly { id: DetectionId; box: BoundingBox }[]): DetectionId | null {
  let best: DetectionId | null = null;
  let bestArea = Infinity;
  for (const { id, box } of boxes) {
    if (p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h) {
      const a = Math.max(0, box.w) * Math.max(0, box.h);
      if (a < bestArea) { bestArea = a; best = id; }
    }
  }
  return best;
}

interface ParsedSize { s: string; long: number; short: number }

function parseSize(s: string): ParsedSize | null {
  const m = /^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/.exec(s);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  if (!(a > 0) || !(b > 0)) return null;
  return { s, long: Math.max(a, b), short: Math.min(a, b) };
}

const is43 = (p: ParsedSize): boolean => Math.abs(p.long / p.short / (4 / 3) - 1) <= 0.02;
const smaller = (p: ParsedSize, q: ParsedSize): number => p.long - q.long || p.long * p.short - q.long * q.short;

/** Android: among "WxH" strings, the smallest 4:3 size (±2 %) whose long side ≥ minLongSide; if none, the largest
 *  4:3 size; if no 4:3 size, the smallest size with long side ≥ minLongSide (else the largest size); undefined when
 *  the list is empty or unparsable (→ camera default). */
export function pickPictureSize(sizes: readonly string[], minLongSide: number): string | undefined {
  const parsed = sizes.map(parseSize).filter((p): p is ParsedSize => p !== null);
  if (parsed.length === 0) return undefined;
  const four3 = parsed.filter(is43);
  const pool = four3.length > 0 ? four3 : parsed;
  const big = pool.filter((p) => p.long >= minLongSide).sort(smaller);
  if (big.length > 0) return big[0].s;
  const all = pool.slice().sort(smaller);
  return all[all.length - 1].s;
}

type Orientation = 'landscape' | 'portrait' | 'square';

function orientationOf(s: Size): Orientation {
  const r = s.width / s.height;
  if (r > 1.05) return 'landscape';
  if (r < 1 / 1.05) return 'portrait';
  return 'square';
}

/** false when one is landscape and the other portrait (aspect on opposite sides of 1, ±5 %). The 180° case cannot
 *  be detected (known limit, R3). */
export function orientationMatches(image: Size, view: Size): boolean {
  const a = orientationOf(image), b = orientationOf(view);
  return !((a === 'landscape' && b === 'portrait') || (a === 'portrait' && b === 'landscape'));
}
