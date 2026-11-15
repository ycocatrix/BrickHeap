// Adaptive live loop (D9). Pure state transition applied after each auto-snapshot tick.
import { VISION } from './config';

export interface LiveTuning { intervalMs: number; segMaxSide: number; failures: number; disabled: boolean }
export const INITIAL_LIVE_TUNING: LiveTuning = {
  intervalMs: VISION.live.intervalMs,
  segMaxSide: VISION.segMaxSide.explore,
  failures: 0,
  disabled: false,
};

/** After each tick. 'ok' with cycleMs > slowCycleMs → intervalMs × 1.5 (≤ maxIntervalMs) and, once intervalMs is at
 *  its max, segMaxSide → exploreMin; 'ok' with cycleMs < slowCycleMs / 2 → intervalMs × 0.8 (≥ intervalMs default);
 *  'ok' and 'skipped' reset failures; 'failed' (thrown capture or ingest) → failures + 1, disabled when
 *  failures ≥ maxFailures. A slow cycle is never a failure. */
export function adaptLive(t: LiveTuning, tick: { outcome: 'ok' | 'skipped' | 'failed'; cycleMs: number }): LiveTuning {
  const L = VISION.live;
  if (tick.outcome === 'failed') {
    const failures = t.failures + 1;
    return { ...t, failures, disabled: t.disabled || failures >= L.maxFailures };
  }
  if (tick.outcome === 'skipped') return { ...t, failures: 0 };

  let { intervalMs, segMaxSide } = t;
  if (tick.cycleMs > L.slowCycleMs) {
    // Already at the max interval and still slow → lower the thumbnail resolution.
    if (intervalMs >= L.maxIntervalMs) segMaxSide = VISION.segMaxSide.exploreMin;
    intervalMs = Math.min(L.maxIntervalMs, Math.round(intervalMs * 1.5));
  } else if (tick.cycleMs < L.slowCycleMs / 2) {
    intervalMs = Math.max(L.intervalMs, Math.round(intervalMs * 0.8));
  }
  return { intervalMs, segMaxSide, failures: 0, disabled: t.disabled };
}
