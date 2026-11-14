import { VISION } from '../config';
import { adaptLive, INITIAL_LIVE_TUNING, type LiveTuning } from '../live';

const L = VISION.live;

describe('adaptLive', () => {
  it('starts from the documented values', () => {
    expect(INITIAL_LIVE_TUNING).toEqual({ intervalMs: 2500, segMaxSide: 256, failures: 0, disabled: false });
  });

  it('stretches the interval on slow cycles, then lowers the thumbnail size', () => {
    let t: LiveTuning = INITIAL_LIVE_TUNING;
    const seen: number[] = [];
    for (let i = 0; i < 10 && t.intervalMs < L.maxIntervalMs; i++) {
      t = adaptLive(t, { outcome: 'ok', cycleMs: 3000 });
      seen.push(t.intervalMs);
      expect(t.segMaxSide).toBe(256);
    }
    expect(seen[0]).toBe(3750);
    expect(t.intervalMs).toBe(L.maxIntervalMs);
    t = adaptLive(t, { outcome: 'ok', cycleMs: 3000 });
    expect(t.intervalMs).toBe(L.maxIntervalMs);
    expect(t.segMaxSide).toBe(VISION.segMaxSide.exploreMin);
    expect(t.failures).toBe(0);
  });

  it('shrinks back to the default interval on fast cycles', () => {
    let t: LiveTuning = { ...INITIAL_LIVE_TUNING, intervalMs: 6000 };
    for (let i = 0; i < 20; i++) t = adaptLive(t, { outcome: 'ok', cycleMs: 500 });
    expect(t.intervalMs).toBe(L.intervalMs);
    // a medium cycle changes nothing
    expect(adaptLive({ ...INITIAL_LIVE_TUNING, intervalMs: 4000 }, { outcome: 'ok', cycleMs: 1500 }).intervalMs).toBe(4000);
  });

  it("'skipped' resets failures", () => {
    const t = adaptLive({ ...INITIAL_LIVE_TUNING, failures: 2 }, { outcome: 'skipped', cycleMs: 100 });
    expect(t.failures).toBe(0);
    expect(t.disabled).toBe(false);
  });

  it('three failures in a row disable live', () => {
    let t: LiveTuning = INITIAL_LIVE_TUNING;
    t = adaptLive(t, { outcome: 'failed', cycleMs: 100 });
    t = adaptLive(t, { outcome: 'failed', cycleMs: 100 });
    expect(t.disabled).toBe(false);
    t = adaptLive(t, { outcome: 'failed', cycleMs: 100 });
    expect(t.failures).toBe(3);
    expect(t.disabled).toBe(true);
  });

  it('a slow cycle never counts as a failure', () => {
    let t: LiveTuning = { ...INITIAL_LIVE_TUNING, failures: 2 };
    for (let i = 0; i < 5; i++) t = adaptLive(t, { outcome: 'ok', cycleMs: 10000 });
    expect(t.failures).toBe(0);
    expect(t.disabled).toBe(false);
  });
});
