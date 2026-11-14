// Small pure helpers of the scanner UI (WP4). Types only, no React Native import: covered by Jest.
import type { ConfidenceLevel, IdentifiedPiece } from '@/domain/types';

/** Minimum delay between two live ticks (§4.6). */
export const MIN_TICK_DELAY_MS = 500;
/** Consecutive orientation mismatches before the « Tenez le téléphone en portrait » hint. */
export const PORTRAIT_HINT_AFTER = 3;
/** RG_01: the drawer header appears from 2 boxes. */
export const DRAWER_MIN_PIECES = 2;

/** Delay before the next live tick: max(intervalMs − elapsed, 500 ms). */
export function nextTickDelay(intervalMs: number, elapsedMs: number): number {
  return Math.max(intervalMs - Math.max(0, elapsedMs), MIN_TICK_DELAY_MS);
}

/** Three drawer heights (collapsed header only · 45 % · 85 % of the container), always increasing. */
export function drawerHeights(containerHeight: number, headerHeight: number): [number, number, number] {
  const collapsed = Math.max(0, headerHeight);
  const mid = Math.max(collapsed + 1, Math.round(containerHeight * 0.45));
  const full = Math.max(mid + 1, Math.round(containerHeight * 0.85));
  return [collapsed, mid, full];
}

/** Snap index after a drag: a fast flick moves one step in its direction, otherwise the nearest height wins.
 *  `vy` is the vertical velocity (positive = downwards = smaller drawer). */
export function nearestSnap(heights: readonly number[], height: number, vy: number, current: number): number {
  if (heights.length === 0) return 0;
  if (vy < -0.5) return Math.min(heights.length - 1, current + 1);
  if (vy > 0.5) return Math.max(0, current - 1);
  let best = 0;
  for (let i = 1; i < heights.length; i++) {
    if (Math.abs(heights[i] - height) < Math.abs(heights[best] - height)) best = i;
  }
  return best;
}

/** Header tap (accessible alternative to dragging): collapsed → mid → full → collapsed. */
export function nextSnapOnTap(current: number, count = 3): number {
  return (current + 1) % count;
}

export function drawerVisible(pieceCount: number): boolean {
  return pieceCount >= DRAWER_MIN_PIECES;
}

/** What a box shows. 'too_small' = the crop was refused (imaging.cropForIdentification → err('invalid')). */
export type PieceStatus = ConfidenceLevel | 'pending' | 'unavailable' | 'empty' | 'too_small';

export function pieceStatus(p: Pick<IdentifiedPiece, 'identification' | 'level' | 'partConfirmed'>): PieceStatus {
  const id = p.identification;
  if (p.partConfirmed) return 'accepted';
  if (id.error === 'invalid') return 'too_small';
  switch (id.status) {
    case 'pending':
      return 'pending';
    case 'unavailable':
      return 'unavailable';
    case 'empty':
      return 'empty';
    default:
      return p.level;
  }
}

/** Level used for colour/icon of a status (grey for everything that is not identified). */
export function statusLevel(s: PieceStatus): ConfidenceLevel {
  return s === 'accepted' || s === 'review' ? s : 'unknown';
}

/** Name of the chosen candidate: catalogue part name, else Brickognize name, else ''. */
export function pieceName(p: Pick<IdentifiedPiece, 'part' | 'identification' | 'chosen'>): string {
  if (p.part) return p.part.name;
  const c = p.chosen >= 0 ? p.identification.candidates[p.chosen] : undefined;
  return c?.name ?? '';
}

/** Render order of boxes: larger first, so a smaller (nested) box is on top and receives the touch, which is
 *  hitTest's "smallest box wins" rule. Stable for equal areas. */
export function paintOrder<T extends { box: { w: number; h: number } }>(items: readonly T[]): T[] {
  return items
    .map((it, i) => ({ it, i, a: it.box.w * it.box.h }))
    .sort((x, y) => y.a - x.a || x.i - y.i)
    .map((x) => x.it);
}

/** RGB → 6 upper-case hex digits (no '#'), the format of CatalogColor.hex. */
export function rgbToHex(rgb: readonly [number, number, number] | null | undefined): string | null {
  if (!rgb) return null;
  return rgb
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

/** Tracks consecutive orientation mismatches of live snapshots. */
export function nextPortraitStreak(streak: number, matches: boolean): number {
  return matches ? 0 : streak + 1;
}
