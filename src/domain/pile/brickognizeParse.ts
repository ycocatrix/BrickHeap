// Pure parsing of Brickognize `/predict/parts/` responses (D4). Never throws.
import type { BoundingBox, Candidate, ColorCandidate, Identification } from '../types';
import { calibrateScore } from './thresholds';

const MAX_CANDIDATES = 3;

/** Brickognize pseudo-items such as '3001special' (special bricks, test bricks, prototypes). */
export function isPseudoItem(id: string): boolean {
  return /special$/i.test(id.trim());
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function parseCandidate(item: unknown): Candidate | null {
  if (!isObj(item)) return null;
  const rawId = typeof item.id === 'number' ? String(item.id) : str(item.id);
  const score = num(item.score);
  if (!rawId || score === null || isPseudoItem(rawId)) return null;
  const rawScore = clamp01(score);
  return {
    bricklinkId: rawId,
    name: str(item.name) ?? rawId,
    imageUrl: str(item.img_url),
    category: str(item.category),
    rawScore,
    confidence: calibrateScore(rawScore),
  };
}

function parseColor(c: unknown): ColorCandidate | null {
  if (!isObj(c)) return null;
  const id = num(c.id);
  const score = num(c.score);
  if (id === null || !Number.isInteger(id) || score === null) return null;
  return { bricklinkColorId: id, name: str(c.name) ?? '', score: clamp01(score) };
}

const unavailable = (): Identification =>
  ({ status: 'unavailable', candidates: [], colors: [], boxScore: 0, error: 'server' });

/** Sorts items by score, drops pseudo-items, keeps ≤ 3, computes Candidate.confidence.
 *  No item → 'empty'. Not an object / no `items` array → 'unavailable' with error 'server'.
 *  A missing or malformed `colors` array → colors []. */
export function parseBrickognizeResponse(json: unknown): Identification {
  if (!isObj(json) || !Array.isArray(json.items)) return unavailable();
  const candidates = json.items
    .map(parseCandidate)
    .filter((c): c is Candidate => c !== null)
    .sort((a, b) => b.rawScore - a.rawScore || (a.bricklinkId < b.bricklinkId ? -1 : 1))
    .slice(0, MAX_CANDIDATES);
  const colors = Array.isArray(json.colors)
    ? json.colors.map(parseColor).filter((c): c is ColorCandidate => c !== null).sort((a, b) => b.score - a.score)
    : [];
  if (candidates.length === 0) return { status: 'empty', candidates: [], colors, boxScore: 0, error: null };
  const bb = isObj(json.bounding_box) ? json.bounding_box : null;
  const boxScore = clamp01((bb && num(bb.score)) ?? 0);
  return { status: 'identified', candidates, colors, boxScore, error: null };
}

/** Brickognize's `bounding_box`, expressed in the server-resized image, normalised with image_width/height.
 *  null when missing, degenerate or malformed. */
export function parseBoundingBox(json: unknown): BoundingBox | null {
  if (!isObj(json) || !isObj(json.bounding_box)) return null;
  const b = json.bounding_box;
  const [l, u, r, lo, iw, ih] = [b.left, b.upper, b.right, b.lower, b.image_width, b.image_height].map(num);
  if (l === null || u === null || r === null || lo === null || !iw || !ih || iw <= 0 || ih <= 0) return null;
  const x = clamp01(l / iw);
  const y = clamp01(u / ih);
  const w = clamp01(r / iw) - x;
  const h = clamp01(lo / ih) - y;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function parseDuration(value: string | null, defaultUnit: 'ms' | 's'): number | null {
  if (!value) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s)?\s*$/i.exec(value);
  if (m) {
    const n = Number(m[1]);
    const unit = (m[2]?.toLowerCase() ?? defaultUnit) as 'ms' | 's';
    return unit === 's' ? n * 1000 : n;
  }
  const date = Date.parse(value);                         // retry-after may be an HTTP date
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/** Delay announced by a 429: `x-retry-in` ('54.075562ms') first, else `retry-after` (seconds or HTTP date).
 *  null when neither header is usable. */
export function retryDelayMs(xRetryIn: string | null, retryAfter: string | null): number | null {
  return parseDuration(xRetryIn, 'ms') ?? parseDuration(retryAfter, 's');
}
