import type { BoundingBox, SegmentationResult } from '../../types';
import { iou } from '../geometry';
import { ciede2000, rgbToLab } from '../lab';
import { segmentPile, segmentPileAsync } from '../segment';
import { makeScene, type SynthBackground, type SynthRect } from '../testing/synth';

// The research prototype (plain CommonJS) is the reference the port must reproduce.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const prototype = require('../../../../docs/research/segment.prototype.js') as {
  segmentPile: (rgba: Uint8Array, w: number, h: number) => {
    boxes: { x: number; y: number; w: number; h: number; tight: number[]; area: number; partial: boolean;
      fromSplit: boolean; suspectMerged: boolean; lab: number[]; rgb: number[] }[];
    background: { quality: string; sigmaL: number; sigmaC: number };
  };
};

const W = 320;
const H = 240;

const FIVE: SynthRect[] = [
  { x: 20, y: 20, w: 40, h: 30, rgb: [201, 26, 9] },
  { x: 120, y: 30, w: 50, h: 40, rgb: [0, 85, 191] },
  { x: 230, y: 25, w: 45, h: 45, rgb: [242, 205, 55] },
  { x: 50, y: 150, w: 60, h: 35, rgb: [35, 120, 65] },
  { x: 190, y: 140, w: 40, h: 60, rgb: [27, 42, 52] },
];

const truth = (r: SynthRect): BoundingBox => ({ x: r.x / W, y: r.y / H, w: r.w / W, h: r.h / H });
const withoutMs = (r: SegmentationResult): Omit<SegmentationResult, 'ms'> => {
  const { ms: _ms, ...rest } = r;
  return rest;
};
const bestIou = (r: SegmentationResult, t: BoundingBox): number => Math.max(0, ...r.boxes.map((b) => iou(b.tight, t)));

describe('segmentPile', () => {
  it.each<SynthBackground>(['white', 'grey', 'gradient'])('finds five separated pieces on a %s background', (bg) => {
    const res = segmentPile(makeScene({ width: W, height: H, background: bg, rects: FIVE, noise: 6, seed: 3 }), W, H);
    expect(res.background.quality).toBe('plain');
    expect(res.boxes).toHaveLength(5);
    expect(res.width).toBe(W);
    expect(res.height).toBe(H);
    for (const r of FIVE) expect(bestIou(res, truth(r))).toBeGreaterThanOrEqual(0.5);
    for (const b of res.boxes) {
      expect(b.partial).toBe(false);
      expect(b.suspectMerged).toBe(false);
      // padded box contains the tight box
      expect(b.box.x).toBeLessThanOrEqual(b.tight.x);
      expect(b.box.y).toBeLessThanOrEqual(b.tight.y);
      expect(b.box.x + b.box.w).toBeGreaterThanOrEqual(b.tight.x + b.tight.w - 1e-9);
    }
    // sorted top-to-bottom, then left-to-right
    const ys = res.boxes.map((b) => b.box.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
  });

  it('reproduces the research prototype exactly', () => {
    for (const bg of ['white', 'grey', 'gradient', 'wood', 'checker'] as const) {
      const img = makeScene({ width: W, height: H, background: bg, rects: FIVE, noise: 6, seed: 7 });
      const port = segmentPile(img, W, H);
      const ref = prototype.segmentPile(img, W, H);
      expect(port.background.quality).toBe(ref.background.quality);
      expect(port.background.sigmaL).toBeCloseTo(ref.background.sigmaL, 9);
      expect(port.boxes.map((b) => [Math.round(b.box.x * W), Math.round(b.box.y * H), Math.round(b.box.w * W),
        Math.round(b.box.h * H), Math.round(b.areaFrac * W * H), b.partial, b.fromSplit, b.suspectMerged, [...b.lab], [...b.rgb]]))
        .toEqual(ref.boxes.map((b) => [b.x, b.y, b.w, b.h, b.area, b.partial, b.fromSplit, b.suspectMerged, b.lab, b.rgb]));
    }
  });

  it('splits two touching pieces of different colours', () => {
    const rects: SynthRect[] = [
      { x: 100, y: 90, w: 60, h: 50, rgb: [201, 26, 9] },
      { x: 160, y: 90, w: 60, h: 50, rgb: [0, 85, 191] },
    ];
    const res = segmentPile(makeScene({ width: W, height: H, background: 'white', rects, noise: 5, seed: 11 }), W, H);
    expect(res.boxes).toHaveLength(2);
    for (const r of rects) expect(bestIou(res, truth(r))).toBeGreaterThanOrEqual(0.5);
  });

  it('flags a piece cut by the border as partial', () => {
    const rects: SynthRect[] = [
      { x: -15, y: 100, w: 50, h: 40, rgb: [201, 26, 9] },
      { x: 150, y: 100, w: 50, h: 40, rgb: [0, 85, 191] },
    ];
    const res = segmentPile(makeScene({ width: W, height: H, background: 'white', rects, noise: 5, seed: 5 }), W, H);
    expect(res.boxes).toHaveLength(2);
    const left = res.boxes.find((b) => b.tight.x < 0.05);
    const inner = res.boxes.find((b) => b.tight.x > 0.4);
    expect(left?.partial).toBe(true);
    expect(inner?.partial).toBe(false);
  });

  it('rates a checkerboard as patterned', () => {
    const res = segmentPile(makeScene({ width: W, height: H, background: 'checker', rects: FIVE, seed: 2 }), W, H);
    expect(res.background.quality).toBe('patterned');
  });

  it('finds nothing on an empty background', () => {
    for (const bg of ['white', 'grey', 'gradient'] as const) {
      const res = segmentPile(makeScene({ width: W, height: H, background: bg, noise: 6, seed: 9 }), W, H);
      expect(res.boxes).toEqual([]);
    }
  });

  it('ignores a soft shadow beside a piece', () => {
    for (const rgb of [[201, 26, 9], [0, 85, 191], [242, 205, 55]] as const) {
      const rect: SynthRect = { x: 120, y: 80, w: 60, h: 50, rgb, shadow: { dx: 10, dy: 8, blur: 8, strength: 0.3 } };
      const res = segmentPile(makeScene({ width: W, height: H, background: 'white', rects: [rect], noise: 5, seed: 4 }), W, H);
      expect(res.boxes).toHaveLength(1);
      expect(iou(res.boxes[0].tight, truth(rect))).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('flags a blob 3.5× the median area as suspectMerged', () => {
    const rects: SynthRect[] = [
      { x: 20, y: 20, w: 30, h: 30, rgb: [201, 26, 9] },
      { x: 120, y: 20, w: 30, h: 30, rgb: [0, 85, 191] },
      { x: 240, y: 20, w: 30, h: 30, rgb: [242, 205, 55] },
      { x: 30, y: 160, w: 30, h: 30, rgb: [35, 120, 65] },
      { x: 150, y: 140, w: 63, h: 50, rgb: [27, 42, 52] }, // 3150 px = 3.5 × 900
    ];
    const res = segmentPile(makeScene({ width: W, height: H, background: 'white', rects, noise: 5, seed: 8 }), W, H);
    expect(res.boxes).toHaveLength(5);
    const merged = res.boxes.filter((b) => b.suspectMerged);
    expect(merged).toHaveLength(1);
    expect(iou(merged[0].tight, truth(rects[4]))).toBeGreaterThanOrEqual(0.5);
  });

  it('keeps a light grey piece when a large white object covers ~30 % of the border ring (sheet on a table)', () => {
    const plate: SynthRect = { x: 250, y: 50, w: 50, h: 60, rgb: [160, 170, 160] };
    const rects: SynthRect[] = [{ x: 0, y: 120, w: 230, h: 120, rgb: [205, 210, 215] }, plate];
    const res = segmentPile(makeScene({ width: W, height: H, background: 'wood', rects, noise: 5, seed: 11 }), W, H);
    // the background model is seeded with the dominant ring colour, so the sheet does not inflate it
    expect(res.background.sigmaC).toBeLessThan(0.06);
    expect(res.boxes.some((b) => !b.partial && iou(b.tight, truth(plate)) >= 0.5)).toBe(true);
  });

  it('measures the dominant colour of a red piece despite a glare stripe', () => {
    const red = [201, 26, 9] as const;
    const rects: SynthRect[] = [
      { x: 110, y: 80, w: 80, h: 60, rgb: red },
      { x: 110, y: 95, w: 80, h: 5, rgb: [250, 240, 235] },
    ];
    const res = segmentPile(makeScene({ width: W, height: H, background: 'grey', rects, noise: 5, seed: 6 }), W, H);
    expect(res.boxes).toHaveLength(1);
    expect(ciede2000(res.boxes[0].lab, rgbToLab(red[0], red[1], red[2]))).toBeLessThan(10);
  });

  it('rejects malformed input with a RangeError', () => {
    expect(() => segmentPile(new Uint8Array(10), W, H)).toThrow(RangeError);
    expect(() => segmentPile(new Uint8Array(15 * 15 * 4), 15, 15)).toThrow(RangeError);
    expect(() => segmentPile(new Uint8Array(W * H * 3), W, H)).toThrow(RangeError);
  });

  it('is deterministic', () => {
    const img = makeScene({ width: W, height: H, background: 'gradient', rects: FIVE, noise: 8, seed: 21 });
    expect(withoutMs(segmentPile(img, W, H))).toEqual(withoutMs(segmentPile(img, W, H)));
    // the input is never mutated
    const copy = img.slice();
    segmentPile(img, W, H);
    expect(img).toEqual(copy);
  });

  it('accepts a Uint8ClampedArray', () => {
    const img = makeScene({ width: W, height: H, background: 'white', rects: FIVE, noise: 6, seed: 3 });
    expect(withoutMs(segmentPile(new Uint8ClampedArray(img), W, H))).toEqual(withoutMs(segmentPile(img, W, H)));
  });

  it('segmentPileAsync yields between stages and matches segmentPile', async () => {
    const img = makeScene({ width: W, height: H, background: 'white', rects: FIVE, noise: 6, seed: 3 });
    let yields = 0;
    const res = await segmentPileAsync(img, W, H, undefined, async () => { yields++; });
    expect(yields).toBeGreaterThanOrEqual(5);
    expect(withoutMs(res)).toEqual(withoutMs(segmentPile(img, W, H)));
    await expect(segmentPileAsync(new Uint8Array(4), W, H, undefined, async () => {})).rejects.toThrow(RangeError);
  });

  it('runs in < 150 ms on 320×240 (JIT)', () => {
    const img = makeScene({ width: W, height: H, background: 'white', rects: FIVE, noise: 6, seed: 3 });
    segmentPile(img, W, H); // warm-up
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      segmentPile(img, W, H);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    expect(times[2]).toBeLessThan(150);
  });
});
