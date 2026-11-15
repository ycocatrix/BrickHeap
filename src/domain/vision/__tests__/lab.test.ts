import type { Lab } from '../../types';
import { ciede2000, hexToLab, labToRgb, rgbToLab } from '../lab';

describe('lab', () => {
  it('maps white and black to the ends of L', () => {
    const w = rgbToLab(255, 255, 255);
    expect(w[0]).toBeCloseTo(100, 1);
    expect(Math.abs(w[1])).toBeLessThan(0.05);
    expect(Math.abs(w[2])).toBeLessThan(0.05);
    expect(rgbToLab(0, 0, 0)[0]).toBeCloseTo(0, 3);
  });

  it('round-trips sRGB within ±1', () => {
    const colours: [number, number, number][] = [
      [0, 0, 0], [255, 255, 255], [201, 26, 9], [0, 85, 191], [242, 205, 55], [35, 120, 65], [27, 42, 52],
      [160, 165, 169], [108, 110, 104], [88, 42, 18], [228, 205, 158], [254, 138, 24], [146, 57, 120],
      [255, 0, 0], [0, 255, 0], [0, 0, 255], [1, 2, 3], [128, 128, 128], [75, 159, 74], [250, 240, 235],
    ];
    for (const [r, g, b] of colours) {
      const back = labToRgb(rgbToLab(r, g, b));
      expect(Math.abs(back[0] - r)).toBeLessThanOrEqual(1);
      expect(Math.abs(back[1] - g)).toBeLessThanOrEqual(1);
      expect(Math.abs(back[2] - b)).toBeLessThanOrEqual(1);
    }
  });

  it('parses hex with or without #', () => {
    expect(hexToLab('#C91A09')).toEqual(hexToLab('C91A09'));
    expect(hexToLab('c91a09')).toEqual(rgbToLab(201, 26, 9));
  });

  // Sharma, Wu, Dalal (2005), "The CIEDE2000 color-difference formula", Table 1.
  const SHARMA: [Lab, Lab, number][] = [
    [[50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485], 2.0425],
    [[50.0, 3.1571, -77.2803], [50.0, 0.0, -82.7485], 2.8615],
    [[50.0, 2.8361, -74.02], [50.0, 0.0, -82.7485], 3.4412],
    [[50.0, 0.0, 0.0], [50.0, -1.0, 2.0], 2.3669],
    [[50.0, 2.49, -0.001], [50.0, -2.49, 0.0009], 7.1792],
    [[50.0, 2.5, 0.0], [73.0, 25.0, -18.0], 27.1492],
    [[50.0, 2.5, 0.0], [50.0, 3.1736, 0.5854], 1.0],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
  ];

  it.each(SHARMA)('matches Sharma test pair %#', (a, b, expected) => {
    expect(Math.abs(ciede2000(a, b) - expected)).toBeLessThan(1e-3);
  });

  it('is symmetric and zero on identical colours', () => {
    for (const [a, b] of SHARMA) expect(ciede2000(a, b)).toBeCloseTo(ciede2000(b, a), 10);
    expect(ciede2000([53, 80, 67], [53, 80, 67])).toBe(0);
  });
});
