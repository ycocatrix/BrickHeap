import type { Lab } from '../../types';
import { bkColor, color, palette } from '../testing/fixtures';

const mockNearest = jest.fn();
jest.mock('../../vision/color', () => ({
  COMMON_OPAQUE_COLOR_IDS: [0, 15, 4, 71, 72, 14, 1],
  nearestColors: (...args: unknown[]) => mockNearest(...args),
}));

// eslint-disable-next-line import/first
import { fuseColor } from '../colorFusion';

// Rebrickable id ← BrickLink id: Red 4 ← 5, Black 0 ← 11, Trans-Red 36 ← 17, Blue 1 ← 7, White 15 ← 1, Unmapped 999 ← null
const PAL = palette([color(4, 5), color(0, 11), color(36, 17, true), color(1, 7), color(15, 1), color(999, null)]);
const LAB: Lab = [50, 60, 40];
const local = (...ids: number[]) => ids.map((colorId, i) => ({ colorId, deltaE: i * 3 }));

beforeEach(() => mockNearest.mockReset().mockReturnValue([]));

describe('fuseColor', () => {
  it('rule 1: strong Brickognize colour is reliable', () => {
    const r = fuseColor({ brickognize: [bkColor(5, 0.85)], lab: LAB, palette: PAL });
    expect(r).toEqual({ colorId: 4, reliable: true, source: 'brickognize', alternatives: [] });
    expect(mockNearest).toHaveBeenCalledWith(LAB, PAL.colors, expect.objectContaining({ k: 3 }));
    const allowed = mockNearest.mock.calls[0][2].allowed as ReadonlySet<number>;
    expect(allowed.has(4)).toBe(true);
  });
  it('rule 1: medium score is reliable only with local agreement', () => {
    mockNearest.mockReturnValue(local(0, 1));
    expect(fuseColor({ brickognize: [bkColor(5, 0.6)], lab: LAB, palette: PAL }).reliable).toBe(false);
    mockNearest.mockReturnValue(local(0, 4));
    expect(fuseColor({ brickognize: [bkColor(5, 0.6)], lab: LAB, palette: PAL }))
      .toEqual({ colorId: 4, reliable: true, source: 'brickognize', alternatives: [0] });
  });
  it('rule 1: transparent colour is reliable without local agreement', () => {
    mockNearest.mockReturnValue(local(4));
    const r = fuseColor({ brickognize: [bkColor(17, 0.55)], lab: LAB, palette: PAL });
    expect(r.colorId).toBe(36);
    expect(r.reliable).toBe(true);
  });
  it('rule 1: lab null path (≥ 0.7 reliable, below not)', () => {
    expect(fuseColor({ brickognize: [bkColor(5, 0.72)], lab: null, palette: PAL }).reliable).toBe(true);
    expect(fuseColor({ brickognize: [bkColor(5, 0.65)], lab: null, palette: PAL }).reliable).toBe(false);
    expect(mockNearest).not.toHaveBeenCalled();
  });
  it('rule 2: weak Brickognize colour is kept but unreliable', () => {
    expect(fuseColor({ brickognize: [bkColor(5, 0.4)], lab: null, palette: PAL }))
      .toEqual({ colorId: 4, reliable: false, source: 'brickognize', alternatives: [] });
  });
  it('rule 3: local only', () => {
    mockNearest.mockReturnValue(local(15, 0, 1));
    expect(fuseColor({ brickognize: [], lab: LAB, palette: PAL }))
      .toEqual({ colorId: 15, reliable: false, source: 'local', alternatives: [0, 1] });
  });
  it('rule 4: nothing', () => {
    expect(fuseColor({ brickognize: [], lab: null, palette: PAL }))
      .toEqual({ colorId: null, reliable: false, source: 'none', alternatives: [] });
  });
  it('unmapped BrickLink colours are dropped', () => {
    const r = fuseColor({ brickognize: [bkColor(12345, 0.95), bkColor(11, 0.3)], lab: null, palette: PAL });
    expect(r.colorId).toBe(0);
    expect(r.reliable).toBe(false);
  });
  it('alternatives are distinct and at most 5', () => {
    mockNearest.mockReturnValue(local(4, 0, 15, 1));
    const r = fuseColor({
      brickognize: [bkColor(5, 0.9), bkColor(11, 0.5), bkColor(17, 0.3), bkColor(7, 0.2), bkColor(1, 0.1)],
      lab: LAB, palette: PAL });
    expect(r.colorId).toBe(4);
    expect(r.alternatives).toEqual([0, 36, 1, 15]);
    mockNearest.mockReturnValue(local(71, 72, 14));
    const r2 = fuseColor({
      brickognize: [bkColor(5, 0.9), bkColor(11, 0.5), bkColor(17, 0.3), bkColor(7, 0.2), bkColor(1, 0.1)],
      lab: LAB, palette: PAL });
    expect(r2.alternatives).toHaveLength(5);
    expect(new Set(r2.alternatives).size).toBe(5);
    expect(r2.alternatives).not.toContain(4);
  });
});
