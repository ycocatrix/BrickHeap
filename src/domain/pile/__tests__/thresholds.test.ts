import { AMBIGUITY, SCORE_CALIBRATION, calibrateScore, confidenceLevel, evaluatePiece } from '../thresholds';
import type { Identification } from '../../types';
import { cand } from '../testing/fixtures';

const ident = (candidates = [cand('3001', 0.9, 0.99), cand('3002', 0.6, 0.7)], boxScore = 0.9,
  status: Identification['status'] = 'identified'): Identification =>
  ({ status, candidates, colors: [], boxScore, error: null });

describe('confidenceLevel', () => {
  it.each([[0.49, 'unknown'], [0.5, 'review'], [0.79, 'review'], [0.8, 'accepted'], [1, 'accepted'], [0, 'unknown']])(
    '%p → %p', (c, level) => expect(confidenceLevel(c as number)).toBe(level));
});

describe('calibrateScore', () => {
  it('hits the anchors', () => {
    expect(calibrateScore(0)).toBe(0);
    expect(calibrateScore(0.5)).toBeCloseTo(0.5, 10);
    expect(calibrateScore(0.65)).toBeCloseTo(0.8, 10);
    expect(calibrateScore(0.9)).toBeCloseTo(0.99, 10);
    expect(calibrateScore(1)).toBeCloseTo(0.99, 10);
    for (const [raw, conf] of SCORE_CALIBRATION) expect(calibrateScore(raw)).toBeCloseTo(conf, 10);
  });
  it('interpolates linearly between anchors', () => {
    expect(calibrateScore(0.575)).toBeCloseTo(0.65, 10);
    expect(calibrateScore(0.25)).toBeCloseTo(0.25, 10);
  });
  it('is monotonic over 0..1 in steps of 0.01', () => {
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = calibrateScore(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
  it('is clamped to 0..0.99', () => {
    expect(calibrateScore(-1)).toBe(0);
    expect(calibrateScore(2)).toBeCloseTo(0.99, 10);
    expect(calibrateScore(Number.NaN)).toBe(0);
    expect(calibrateScore(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('evaluatePiece', () => {
  it('returns the candidate confidence when unambiguous', () => {
    expect(evaluatePiece({ identification: ident(), chosen: 0, partConfirmed: false }))
      .toEqual({ confidence: 0.99, level: 'accepted' });
  });
  it('caps an ambiguous top-2 (within the margin)', () => {
    const r = evaluatePiece({ identification: ident([cand('a', 0.9, 0.99), cand('b', 0.86, 0.95)]), chosen: 0,
      partConfirmed: false });
    expect(r).toEqual({ confidence: AMBIGUITY.cap, level: 'review' });
    // exactly at the margin
    const r2 = evaluatePiece({ identification: ident([cand('a', 0.7, 0.88), cand('b', 0.65, 0.8)]), chosen: 0,
      partConfirmed: false });
    expect(r2.confidence).toBe(AMBIGUITY.cap);
  });
  it('does not apply the ambiguity cap to a non-top choice', () => {
    const r = evaluatePiece({ identification: ident([cand('a', 0.9, 0.99), cand('b', 0.88, 0.97)]), chosen: 1,
      partConfirmed: false });
    expect(r.confidence).toBe(0.97);
  });
  it('caps when the box score is low', () => {
    const r = evaluatePiece({ identification: ident(undefined, 0.3), chosen: 0, partConfirmed: false });
    expect(r).toEqual({ confidence: 0.79, level: 'review' });
  });
  it('partConfirmed → 1', () => {
    expect(evaluatePiece({ identification: ident([], 0, 'empty'), chosen: -1, partConfirmed: true }))
      .toEqual({ confidence: 1, level: 'accepted' });
  });
  it.each(['pending', 'empty', 'unavailable'] as const)('%s → 0 and unknown', (status) => {
    expect(evaluatePiece({ identification: ident(undefined, 0.9, status), chosen: 0, partConfirmed: false }))
      .toEqual({ confidence: 0, level: 'unknown' });
  });
  it('chosen < 0 → 0 and unknown', () => {
    expect(evaluatePiece({ identification: ident(), chosen: -1, partConfirmed: false }))
      .toEqual({ confidence: 0, level: 'unknown' });
  });
});
