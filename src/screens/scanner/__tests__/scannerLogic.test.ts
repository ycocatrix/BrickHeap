import type { IdentifiedPiece, Identification } from '@/domain/types';
import {
  drawerHeights, drawerVisible, nearestSnap, nextPortraitStreak, nextSnapOnTap, nextTickDelay, paintOrder, pieceName,
  pieceStatus, rgbToHex, statusLevel,
} from '../scannerLogic';

const ident = (o: Partial<Identification> = {}): Identification => ({
  status: 'identified', candidates: [], colors: [], boxScore: 0.9, error: null, ...o,
});
const cand = (name: string) => ({ bricklinkId: 'x', name, imageUrl: null, category: null, rawScore: 0.7, confidence: 0.8 });

describe('nextTickDelay', () => {
  it('waits the rest of the interval', () => expect(nextTickDelay(2500, 1000)).toBe(1500));
  it('never goes below 500 ms', () => {
    expect(nextTickDelay(2500, 2400)).toBe(500);
    expect(nextTickDelay(2500, 9000)).toBe(500);
  });
  it('ignores a negative elapsed time', () => expect(nextTickDelay(2500, -10)).toBe(2500));
});

describe('drawer', () => {
  it('computes three increasing heights', () => {
    expect(drawerHeights(1000, 56)).toEqual([56, 450, 850]);
    const [a, b, c] = drawerHeights(50, 56);
    expect(a < b && b < c).toBe(true);
  });
  it('snaps to the nearest height without velocity', () => {
    const h = [56, 450, 850];
    expect(nearestSnap(h, 100, 0, 0)).toBe(0);
    expect(nearestSnap(h, 400, 0, 0)).toBe(1);
    expect(nearestSnap(h, 800, 0, 1)).toBe(2);
  });
  it('moves one step on a flick', () => {
    const h = [56, 450, 850];
    expect(nearestSnap(h, 60, -1, 0)).toBe(1);
    expect(nearestSnap(h, 840, -1, 2)).toBe(2);
    expect(nearestSnap(h, 840, 1, 2)).toBe(1);
    expect(nearestSnap(h, 60, 1, 0)).toBe(0);
  });
  it('cycles on header tap', () => {
    expect([0, 1, 2].map((i) => nextSnapOnTap(i))).toEqual([1, 2, 0]);
  });
  it('appears from 2 pieces (RG_01)', () => {
    expect(drawerVisible(0)).toBe(false);
    expect(drawerVisible(1)).toBe(false);
    expect(drawerVisible(2)).toBe(true);
  });
});

describe('pieceStatus', () => {
  const base = { level: 'accepted' as const, partConfirmed: false };
  it('maps identification statuses', () => {
    expect(pieceStatus({ ...base, identification: ident({ status: 'pending' }) })).toBe('pending');
    expect(pieceStatus({ ...base, identification: ident({ status: 'unavailable', error: 'offline' }) })).toBe('unavailable');
    expect(pieceStatus({ ...base, identification: ident({ status: 'empty' }) })).toBe('empty');
    expect(pieceStatus({ ...base, level: 'review', identification: ident() })).toBe('review');
  });
  it('reports a refused crop as too small', () => {
    expect(pieceStatus({ ...base, identification: ident({ status: 'unavailable', error: 'invalid' }) })).toBe('too_small');
  });
  it('a confirmed part is accepted', () => {
    expect(pieceStatus({ level: 'unknown', partConfirmed: true, identification: ident({ status: 'empty' }) })).toBe('accepted');
  });
  it('statusLevel greys everything not identified', () => {
    expect(statusLevel('accepted')).toBe('accepted');
    expect(statusLevel('review')).toBe('review');
    expect(statusLevel('pending')).toBe('unknown');
    expect(statusLevel('too_small')).toBe('unknown');
  });
});

describe('pieceName', () => {
  it('prefers the catalogue part, then the chosen candidate', () => {
    const part = { name: 'Brick 2 x 4' } as IdentifiedPiece['part'];
    expect(pieceName({ part, chosen: 0, identification: ident({ candidates: [cand('Other')] }) })).toBe('Brick 2 x 4');
    expect(pieceName({ part: null, chosen: 0, identification: ident({ candidates: [cand('Plate 1 x 2')] }) })).toBe('Plate 1 x 2');
    expect(pieceName({ part: null, chosen: -1, identification: ident({ candidates: [cand('Plate 1 x 2')] }) })).toBe('');
  });
});

describe('paintOrder', () => {
  it('paints larger boxes first (smallest on top), stable', () => {
    const items = [
      { id: 'a', box: { w: 0.1, h: 0.1 } },
      { id: 'b', box: { w: 0.5, h: 0.5 } },
      { id: 'c', box: { w: 0.1, h: 0.1 } },
    ];
    expect(paintOrder(items).map((i) => i.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('misc', () => {
  it('rgbToHex', () => {
    expect(rgbToHex([201, 26, 9])).toBe('C91A09');
    expect(rgbToHex([300, -4, 15.6])).toBe('FF0010');
    expect(rgbToHex(null)).toBeNull();
  });
  it('nextPortraitStreak', () => {
    expect(nextPortraitStreak(2, false)).toBe(3);
    expect(nextPortraitStreak(2, true)).toBe(0);
  });
});
