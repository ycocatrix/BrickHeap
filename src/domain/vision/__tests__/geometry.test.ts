import type { BoundingBox } from '../../types';
import {
  boxToPixelRect, boxToView, clampBox, containTransform, coverTransform, fitWithin, hitTest, iou, nms,
  orientationMatches, pickPictureSize, viewToImagePoint,
} from '../geometry';

const b = (x: number, y: number, w: number, h: number): BoundingBox => ({ x, y, w, h });

describe('iou', () => {
  it('handles identical, disjoint, half-overlap and degenerate boxes', () => {
    expect(iou(b(0.1, 0.1, 0.3, 0.3), b(0.1, 0.1, 0.3, 0.3))).toBeCloseTo(1, 10);
    expect(iou(b(0, 0, 0.2, 0.2), b(0.5, 0.5, 0.2, 0.2))).toBe(0);
    expect(iou(b(0, 0, 0.2, 0.2), b(0.2, 0, 0.2, 0.2))).toBe(0); // touching
    expect(iou(b(0, 0, 0.4, 0.2), b(0.2, 0, 0.4, 0.2))).toBeCloseTo(1 / 3, 10);
    expect(iou(b(0, 0, 0, 0.2), b(0, 0, 0.2, 0.2))).toBe(0);
  });
});

describe('nms', () => {
  it('drops the lower score of a pair above the threshold and keeps both below', () => {
    // same height, widths 1 shifted: IoU = (1-d)/(1+d); d = 3/17 → 0.7, d = 1/3 → 0.5
    const hi = { box: b(0, 0, 0.5, 0.5), score: 0.9, id: 'hi' };
    const lo7 = { box: b(0.5 * (3 / 17), 0, 0.5, 0.5), score: 0.5, id: 'lo7' };
    const lo5 = { box: b(0.5 / 3, 0, 0.5, 0.5), score: 0.5, id: 'lo5' };
    expect(iou(hi.box, lo7.box)).toBeCloseTo(0.7, 6);
    expect(iou(hi.box, lo5.box)).toBeCloseTo(0.5, 6);
    expect(nms([lo7, hi]).map((x) => x.id)).toEqual(['hi']);
    expect(nms([lo5, hi]).map((x) => x.id)).toEqual(['hi', 'lo5']);
    expect(nms([lo5, hi], 0.4).map((x) => x.id)).toEqual(['hi']);
  });
});

describe('clampBox / boxToPixelRect / fitWithin', () => {
  it('clamps inside [0,1]', () => {
    expect(clampBox(b(-0.1, 0.9, 0.3, 0.3))).toEqual({ x: 0, y: 0.9, w: expect.closeTo(0.2, 10), h: expect.closeTo(0.1, 10) });
    expect(clampBox(b(1.2, 0.5, 0.3, 0.1))).toEqual({ x: 1, y: 0.5, w: 0, h: expect.closeTo(0.1, 10) });
  });

  it('returns integer, non-empty rects inside the image', () => {
    expect(boxToPixelRect(b(0.25, 0.5, 0.5, 0.25), { width: 400, height: 300 }))
      .toEqual({ originX: 100, originY: 150, width: 200, height: 75 });
    const outside = boxToPixelRect(b(-0.5, 1.2, 0.2, 0.2), { width: 400, height: 300 });
    expect(outside.width).toBeGreaterThanOrEqual(1);
    expect(outside.height).toBeGreaterThanOrEqual(1);
    expect(outside.originX).toBe(0);
    expect(outside.originY + outside.height).toBeLessThanOrEqual(300);
    const tiny = boxToPixelRect(b(0.5, 0.5, 0, 0), { width: 400, height: 300 });
    expect(tiny).toEqual({ originX: 200, originY: 150, width: 1, height: 1 });
    const full = boxToPixelRect(b(0, 0, 1, 1), { width: 400, height: 300 });
    expect(full).toEqual({ originX: 0, originY: 0, width: 400, height: 300 });
  });

  it('fits within a max side without upscaling', () => {
    expect(fitWithin({ width: 4032, height: 3024 }, 320)).toEqual({ width: 320, height: 240 });
    expect(fitWithin({ width: 1080, height: 1920 }, 256)).toEqual({ width: 144, height: 256 });
    expect(fitWithin({ width: 200, height: 100 }, 320)).toEqual({ width: 200, height: 100 });
  });
});

describe('view transforms', () => {
  const image = { width: 400, height: 300 };
  const view = { width: 300, height: 600 };

  it('computes cover and contain transforms', () => {
    expect(coverTransform(image, view)).toEqual({ scale: 2, dx: -250, dy: 0 });
    expect(containTransform(image, view)).toEqual({ scale: 0.75, dx: 0, dy: 187.5 });
  });

  it('round-trips boxToView and viewToImagePoint', () => {
    for (const t of [coverTransform(image, view), containTransform(image, view)]) {
      const box = b(0.4, 0.3, 0.2, 0.4);
      const v = boxToView(box, image, t);
      const p = viewToImagePoint({ x: v.left + v.width / 2, y: v.top + v.height / 2 }, image, t);
      expect(p?.x).toBeCloseTo(0.5, 10);
      expect(p?.y).toBeCloseTo(0.5, 10);
    }
    const contain = containTransform(image, view);
    expect(viewToImagePoint({ x: 150, y: 10 }, image, contain)).toBeNull(); // letterbox
  });

  it('hitTest picks the smallest containing box', () => {
    const boxes = [
      { id: 'big', box: b(0, 0, 1, 1) },
      { id: 'small', box: b(0.4, 0.4, 0.2, 0.2) },
      { id: 'mid', box: b(0.3, 0.3, 0.4, 0.4) },
    ];
    expect(hitTest({ x: 0.5, y: 0.5 }, boxes)).toBe('small');
    expect(hitTest({ x: 0.35, y: 0.35 }, boxes)).toBe('mid');
    expect(hitTest({ x: 0.5, y: 0.5 }, [])).toBeNull();
    expect(hitTest({ x: 0.9, y: 0.9 }, boxes.slice(1))).toBeNull();
  });
});

describe('pickPictureSize', () => {
  it('picks the smallest 4:3 size whose long side ≥ min', () => {
    expect(pickPictureSize(['1280x720', '1920x1080', '4032x3024', '2048x1536', '1600x1200'], 1920)).toBe('2048x1536');
  });
  it('falls back to the largest 4:3, then to the smallest size ≥ min', () => {
    expect(pickPictureSize(['1600x1200', '1280x960', '1920x1080'], 1920)).toBe('1600x1200');
    expect(pickPictureSize(['2560x1440', '1920x1080', '1280x720'], 1920)).toBe('1920x1080');
  });
  it('returns undefined for an empty or unparsable list', () => {
    expect(pickPictureSize([], 1920)).toBeUndefined();
    expect(pickPictureSize(['Photo', 'High'], 1920)).toBeUndefined();
  });
});

describe('orientationMatches', () => {
  it('compares landscape/portrait with a square tolerance', () => {
    expect(orientationMatches({ width: 1080, height: 1440 }, { width: 390, height: 844 })).toBe(true);
    expect(orientationMatches({ width: 1440, height: 1080 }, { width: 390, height: 844 })).toBe(false);
    expect(orientationMatches({ width: 1000, height: 1030 }, { width: 844, height: 390 })).toBe(true);
    expect(orientationMatches({ width: 1440, height: 1080 }, { width: 844, height: 390 })).toBe(true);
  });
});
