import type { BoundingBox } from '../../types';
import { iou } from '../geometry';
import { updateTracks, type Track } from '../tracker';

const b = (x: number, y: number, w: number, h: number): BoundingBox => ({ x, y, w, h });
const ids = () => { let n = 0; return () => `t${++n}`; };

describe('updateTracks', () => {
  it('keeps the id of the same box and counts hits', () => {
    const newId = ids();
    const first = updateTracks([], [b(0.1, 0.1, 0.4, 0.4)], newId);
    expect(first.assigned).toEqual(['t1']);
    expect(first.tracks).toEqual([{ id: 't1', box: b(0.1, 0.1, 0.4, 0.4), hits: 1, misses: 0 }]);
    const second = updateTracks(first.tracks, [b(0.1, 0.1, 0.4, 0.4)], newId);
    expect(second.assigned).toEqual(['t1']);
    expect(second.tracks[0].hits).toBe(2);
    expect(second.removed).toEqual([]);
  });

  it('matches a shifted box at IoU 0.6 and not at IoU 0.4', () => {
    const base: Track[] = [{ id: 'a', box: b(0, 0, 0.4, 0.4), hits: 1, misses: 0 }];
    const near = b(0.1, 0, 0.4, 0.4);
    const far = b(0.18, 0, 0.4, 0.4);
    expect(iou(base[0].box, near)).toBeCloseTo(0.6, 6);
    expect(iou(base[0].box, far)).toBeLessThan(0.4);
    expect(updateTracks(base, [near], ids()).assigned).toEqual(['a']);
    const res = updateTracks(base, [far], ids());
    expect(res.assigned).toEqual(['t1']);
    expect(res.tracks.find((t) => t.id === 'a')?.misses).toBe(1);
  });

  it('keeps a track missed once and removes it when missed twice', () => {
    const t0: Track[] = [{ id: 'a', box: b(0, 0, 0.3, 0.3), hits: 3, misses: 0 }];
    const once = updateTracks(t0, [], ids());
    expect(once.tracks).toEqual([{ id: 'a', box: b(0, 0, 0.3, 0.3), hits: 3, misses: 1 }]);
    expect(once.removed).toEqual([]);
    const twice = updateTracks(once.tracks, [], ids());
    expect(twice.tracks).toEqual([]);
    expect(twice.removed).toEqual(['a']);
  });

  it('matches two tracks and two boxes one-to-one by best IoU', () => {
    const tracks: Track[] = [
      { id: 'a', box: b(0.1, 0.1, 0.3, 0.3), hits: 2, misses: 0 },
      { id: 'b', box: b(0.15, 0.1, 0.3, 0.3), hits: 2, misses: 0 },
    ];
    // box 0 is nearest to b, box 1 nearest to a; both overlap both tracks above the threshold
    const boxes = [b(0.16, 0.1, 0.3, 0.3), b(0.09, 0.1, 0.3, 0.3)];
    const res = updateTracks(tracks, boxes, ids());
    expect(res.assigned).toEqual(['b', 'a']);
    expect(new Set(res.assigned).size).toBe(2);
    expect(res.tracks.every((t) => t.hits === 3)).toBe(true);
  });
});
