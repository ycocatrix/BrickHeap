import type { CatalogColor } from '../../types';
import { COMMON_OPAQUE_COLOR_IDS, nearestColors } from '../color';
import { hexToLab } from '../lab';

const c = (colorId: number, name: string, hex: string, isTrans = false): CatalogColor =>
  ({ colorId, name, hex, isTrans, bricklinkId: null });

const PALETTE: CatalogColor[] = [
  c(-1, '[Unknown]', 'C91A09'),
  c(9999, '[No Color/Any Color]', 'C91A09'),
  c(36, 'Trans-Red', 'C91A09', true),
  c(4, 'Red', 'C91A09'),
  c(1, 'Blue', '0055BF'),
  c(0, 'Black', '05131D'),
  c(15, 'White', 'FFFFFF'),
  c(14, 'Yellow', 'F2CD37'),
  c(25, 'Orange', 'FE8A18'),
  c(320, 'Dark Red', '720E0F'),
];

describe('nearestColors', () => {
  it('ranks the exact hex first with ΔE 0', () => {
    const res = nearestColors(hexToLab('C91A09'), PALETTE);
    expect(res[0]).toEqual({ colorId: 4, deltaE: 0 });
  });

  it('skips transparent colours, negative ids and 9999', () => {
    const ids = nearestColors(hexToLab('C91A09'), PALETTE, { k: 100 }).map((m) => m.colorId);
    expect(ids).not.toContain(-1);
    expect(ids).not.toContain(9999);
    expect(ids).not.toContain(36);
    expect(ids).toHaveLength(7);
  });

  it('honours k (default 3) and sorts by ΔE', () => {
    const lab = hexToLab('D02010');
    expect(nearestColors(lab, PALETTE)).toHaveLength(3);
    const five = nearestColors(lab, PALETTE, { k: 5 });
    expect(five).toHaveLength(5);
    for (let i = 1; i < five.length; i++) expect(five[i].deltaE).toBeGreaterThanOrEqual(five[i - 1].deltaE);
  });

  it('honours allowed', () => {
    const res = nearestColors(hexToLab('C91A09'), PALETTE, { allowed: new Set([1, 15]) });
    expect(res.map((m) => m.colorId).sort()).toEqual([1, 15]);
  });
});

describe('COMMON_OPAQUE_COLOR_IDS', () => {
  it('has 40 distinct ids', () => {
    expect(COMMON_OPAQUE_COLOR_IDS).toHaveLength(40);
    expect(new Set(COMMON_OPAQUE_COLOR_IDS).size).toBe(40);
  });
});
