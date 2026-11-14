import type { BoundingBox, SegBox, SegmentationResult } from '../../types';
import { VISION } from '../config';
import { manualDetection, toDetections, wholeImageDetection } from '../detections';

const box = (x: number, y: number, w: number, h: number): BoundingBox => ({ x, y, w, h });
const seg = (tight: BoundingBox, padded: BoundingBox = tight): SegBox => ({
  box: padded, tight, areaFrac: tight.w * tight.h * 0.8, partial: false, fromSplit: false, suspectMerged: false,
  lab: [50, 10, 10], rgb: [120, 100, 90],
});
const result = (boxes: SegBox[]): SegmentationResult => ({
  boxes, background: { quality: 'plain', sigmaL: 1, sigmaC: 0.02 }, width: 320, height: 240, ms: 1,
});
const ids = () => { let n = 0; return () => `d${++n}`; };

describe('toDetections', () => {
  it('applies NMS on tight boxes (score = areaFrac)', () => {
    // tight boxes overlap at IoU 0.7: the larger survives; padded boxes would overlap more but are ignored
    const big = seg(box(0.1, 0.1, 0.2, 0.2 * 1.0), box(0.05, 0.05, 0.3, 0.3));
    const small = seg(box(0.1, 0.1, 0.2, 0.14), box(0.05, 0.05, 0.3, 0.25));
    const far = seg(box(0.6, 0.6, 0.1, 0.1));
    const { detections, truncated } = toDetections(result([small, big, far]), ids());
    expect(truncated).toBe(false);
    expect(detections).toHaveLength(2);
    expect(detections[0].box).toEqual(big.box); // padded box is the detection box
    expect(detections[0].source).toBe('segmentation');
    expect(detections[0].lab).toEqual([50, 10, 10]);
    expect(detections[1].box).toEqual(far.box);
  });

  it('keeps padded boxes whose tight boxes do not overlap enough', () => {
    const a = seg(box(0.1, 0.1, 0.1, 0.1), box(0.05, 0.05, 0.25, 0.25));
    const b = seg(box(0.21, 0.1, 0.1, 0.1), box(0.16, 0.05, 0.25, 0.25));
    expect(toDetections(result([a, b]), ids()).detections).toHaveLength(2);
  });

  it(`caps at VISION.maxBoxes (${VISION.maxBoxes}) keeping the largest`, () => {
    const boxes: SegBox[] = [];
    for (let i = 0; i < 70; i++) {
      const s = 0.01 + i * 0.0001;
      boxes.push(seg(box((i % 10) * 0.1, Math.floor(i / 10) * 0.1, s, s)));
    }
    const { detections, truncated } = toDetections(result(boxes), ids());
    expect(truncated).toBe(true);
    expect(detections).toHaveLength(VISION.maxBoxes);
    const minKept = Math.min(...detections.map((d) => d.box.w));
    expect(minKept).toBeCloseTo(0.01 + 10 * 0.0001, 10);
    expect(new Set(detections.map((d) => d.id)).size).toBe(VISION.maxBoxes);
  });
});

describe('wholeImageDetection', () => {
  it('covers the image', () => {
    expect(wholeImageDetection('w')).toEqual({
      id: 'w', box: { x: 0, y: 0, w: 1, h: 1 }, partial: false, suspectMerged: false, source: 'whole_image', lab: null, rgb: null,
    });
  });
});

describe('manualDetection', () => {
  const image = { width: 400, height: 300 };

  it('is pixel-square with the default side (18 % of the short side)', () => {
    const d = manualDetection('m', { x: 0.5, y: 0.5 }, image, []);
    expect(d.source).toBe('manual');
    expect(d.lab).toBeNull();
    expect(d.box.w * image.width).toBeCloseTo(54, 6);
    expect(d.box.h * image.height).toBeCloseTo(54, 6);
    expect(d.box.x + d.box.w / 2).toBeCloseTo(0.5, 10);
  });

  it('uses the median long side of other detections', () => {
    const others = [0.1, 0.2, 0.3].map((w, i) => ({ ...wholeImageDetection(`o${i}`), box: box(0, 0, w, 0.05) }));
    const d = manualDetection('m', { x: 0.5, y: 0.5 }, image, others);
    expect(d.box.w * image.width).toBeCloseTo(80, 6);
    expect(d.box.h * image.height).toBeCloseTo(80, 6);
  });

  it('is clamped inside the image', () => {
    for (const center of [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }]) {
      const d = manualDetection('m', center, image, []);
      expect(d.box.x).toBeGreaterThanOrEqual(0);
      expect(d.box.y).toBeGreaterThanOrEqual(0);
      expect(d.box.x + d.box.w).toBeLessThanOrEqual(1 + 1e-12);
      expect(d.box.y + d.box.h).toBeLessThanOrEqual(1 + 1e-12);
      expect(d.box.w * image.width).toBeCloseTo(d.box.h * image.height, 6);
    }
  });
});
