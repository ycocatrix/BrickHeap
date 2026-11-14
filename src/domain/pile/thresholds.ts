// RG_04 + D5: thresholds apply to a calibrated confidence, not to the raw Brickognize similarity.
import type { ConfidenceLevel, IdentifiedPiece } from '../types';

export const THRESHOLDS = { accepted: 0.8, review: 0.5 } as const;
/** Piecewise-linear calibration curve (raw similarity → confidence). Tuned with Calibration mode (§7.1). */
export const SCORE_CALIBRATION: readonly (readonly [raw: number, confidence: number])[] = [
  [0, 0], [0.5, 0.5], [0.65, 0.8], [0.9, 0.99], [1, 0.99],
];
export const AMBIGUITY = { margin: 0.05, cap: 0.79, minBoxScore: 0.5 } as const;

const MAX_CONFIDENCE = 0.99;
const EPS = 1e-9;

/** Piecewise-linear, monotonic, clamped 0..0.99. Non-finite input → 0. */
export function calibrateScore(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  const pts = SCORE_CALIBRATION;
  const first = pts[0];
  const last = pts[pts.length - 1];
  let value: number;
  if (raw <= first[0]) value = first[1];
  else if (raw >= last[0]) value = last[1];
  else {
    value = last[1];
    for (let i = 1; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      if (raw <= x1) {
        const [x0, y0] = pts[i - 1];
        value = x1 === x0 ? y1 : y0 + ((raw - x0) / (x1 - x0)) * (y1 - y0);
        break;
      }
    }
  }
  return Math.min(MAX_CONFIDENCE, Math.max(0, value));
}

/** ≥ 0.8 accepted · ≥ 0.5 review · else unknown. */
export function confidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence >= THRESHOLDS.accepted - EPS) return 'accepted';
  if (confidence >= THRESHOLDS.review - EPS) return 'review';
  return 'unknown';
}

/** confidence = 1 if partConfirmed; 0 if status ≠ 'identified' or chosen < 0; else candidate.confidence, capped at
 *  AMBIGUITY.cap when (top-2 rawScore within margin of top-1 and chosen = 0) or boxScore < minBoxScore. */
export function evaluatePiece(p: Pick<IdentifiedPiece, 'identification' | 'chosen' | 'partConfirmed'>):
  { confidence: number; level: ConfidenceLevel } {
  if (p.partConfirmed) return { confidence: 1, level: 'accepted' };
  const { identification: id, chosen } = p;
  const cand = chosen >= 0 ? id.candidates[chosen] : undefined;
  if (id.status !== 'identified' || !cand) return { confidence: 0, level: 'unknown' };
  let confidence = cand.confidence;
  const second = id.candidates[1];
  const ambiguous = chosen === 0 && second !== undefined
    && id.candidates[0].rawScore - second.rawScore <= AMBIGUITY.margin + EPS;
  if (ambiguous || id.boxScore < AMBIGUITY.minBoxScore) confidence = Math.min(confidence, AMBIGUITY.cap);
  return { confidence, level: confidenceLevel(confidence) };
}
