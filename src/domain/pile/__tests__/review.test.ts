import {
  chooseCandidate, confirmAllColors, confirmPartial, createReview, removeLine, restoreLine, reviewLines, reviewSummary,
  setLineColor, setLineQuantity, toDeltas,
} from '../review';
import { cand, part, piece } from '../testing/fixtures';

jest.mock('../../catalog/partInfo', () => jest.requireActual('../testing/fixtures').partInfoMock);

const keys = (s: ReturnType<typeof createReview>) => reviewLines(s).map((l) => [l.key, l.quantity]);

describe('quantities', () => {
  const s = createReview([piece({ id: 'a' }), piece({ id: 'b', x: 0.5 })]);
  it('defaults to the group count and clamps overrides', () => {
    expect(keys(s)).toEqual([['p:3001|4', 2]]);
    expect(keys(setLineQuantity(s, 'p:3001|4', 120))).toEqual([['p:3001|4', 120]]);
    expect(keys(setLineQuantity(s, 'p:3001|4', 123456))).toEqual([['p:3001|4', 9999]]);
    expect(keys(setLineQuantity(s, 'p:3001|4', 2.6))).toEqual([['p:3001|4', 3]]);
  });
  it('0 removes the line; restore brings it back with its count', () => {
    const removed = setLineQuantity(setLineQuantity(s, 'p:3001|4', 5), 'p:3001|4', 0);
    expect(reviewLines(removed)).toEqual([]);
    expect(removed.removed).toEqual(['p:3001|4']);
    expect(keys(restoreLine(removed, 'p:3001|4'))).toEqual([['p:3001|4', 2]]);
    expect(keys(setLineQuantity(s, 'p:3001|4', -3))).toEqual([]);
  });
  it('removeLine / restoreLine', () => {
    const r = removeLine(s, 'p:3001|4');
    expect(reviewLines(r)).toEqual([]);
    expect(restoreLine(r, 'p:3001|4').removed).toEqual([]);
  });
  it('does not mutate the input state', () => {
    const before = JSON.stringify(s);
    setLineQuantity(s, 'p:3001|4', 7);
    removeLine(s, 'p:3001|4');
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('setLineColor', () => {
  it('merges into the existing key and drops both overrides', () => {
    let s = createReview([
      piece({ id: 'a' }), piece({ id: 'b', x: 0.5 }),
      piece({ id: 'c', reliable: false, y: 0.6 }), piece({ id: 'd', colorId: 15, reliable: false, y: 0.7 }),
    ]);
    s = setLineQuantity(s, 'p:3001|4', 5);
    s = setLineQuantity(s, 'c:3001|15', 4);
    expect(keys(s)).toEqual([['p:3001|4', 5], ['c:3001|15', 4], ['c:3001|4', 1]]);
    const next = setLineColor(s, 'c:3001|15', 4);
    expect(keys(next)).toEqual([['p:3001|4', 3], ['c:3001|4', 1]]);
    const d = next.pieces.find((p) => p.detection.id === 'd')!;
    expect(d.color).toMatchObject({ colorId: 4, reliable: true, source: 'user' });
    expect(next.quantities).toEqual({});
  });
  it('unknown key → unchanged state', () => {
    const s = createReview([piece({ id: 'a' })]);
    expect(setLineColor(s, 'p:nope|1', 4)).toBe(s);
  });
});

describe('confirmAllColors', () => {
  it('confirms every color_to_confirm line with a colour and skips colorId null', () => {
    const s = createReview([
      piece({ id: 'a', reliable: false }),
      piece({ id: 'b', partId: '3020', colorId: 71, reliable: false, y: 0.5 }),
      piece({ id: 'c', partId: '3003', colorId: null, reliable: false, y: 0.7 }),
    ]);
    const next = confirmAllColors(s);
    expect(reviewLines(next).map((l) => [l.key, l.kind])).toEqual([
      ['p:3001|4', 'ok'], ['p:3020|71', 'ok'], ['c:3003|?', 'color_to_confirm']]);
  });
});

describe('confirmPartial', () => {
  it('counts a partial piece in its line', () => {
    const s = createReview([piece({ id: 'a' }), piece({ id: 'x', partial: true, y: 0.9 })]);
    expect(keys(s)).toEqual([['p:3001|4', 1], ['x:x', 1]]);
    const next = confirmPartial(s, 'x:x');
    expect(keys(next)).toEqual([['p:3001|4', 2]]);
    expect(next.pieces.find((p) => p.detection.id === 'x')!.partialConfirmed).toBe(true);
  });
});

describe('chooseCandidate', () => {
  it('applies to every member of a three-member line, appends the candidate and merges', () => {
    let s = createReview([
      piece({ id: 'r1', partId: '3010', confidence: 0.6, candidates: [cand('3010', 0.6), cand('3009', 0.5)] }),
      piece({ id: 'r2', partId: '3010', confidence: 0.6, x: 0.4, candidates: [cand('3010', 0.6)] }),
      piece({ id: 'r3', partId: '3010', confidence: 0.6, x: 0.7, candidates: [cand('3010', 0.6), cand('3009', 0.55)] }),
      piece({ id: 'o', partId: '3009', y: 0.9 }),
    ]);
    s = setLineQuantity(s, 'p:3010|4', 2);
    const line = reviewLines(s).find((l) => l.key === 'p:3010|4')!;
    expect(line.level).toBe('review');
    const next = chooseCandidate(s, line.detectionIds, cand('3009', 0.5), part('3009'));
    expect(keys(next)).toEqual([['p:3009|4', 4]]);
    const [r1, r2, r3] = ['r1', 'r2', 'r3'].map((id) => next.pieces.find((p) => p.detection.id === id)!);
    expect(r1.chosen).toBe(1);
    expect(r2.identification.candidates.map((c) => c.bricklinkId)).toEqual(['3010', '3009']);
    expect(r2.chosen).toBe(1);
    expect(r3.chosen).toBe(1);
    for (const p of [r1, r2, r3]) {
      expect(p).toMatchObject({ partConfirmed: true, confidence: 1, level: 'accepted' });
      expect(p.part!.partId).toBe('3009');
    }
  });
  it('turns an unknown piece into a known one', () => {
    const s = createReview([piece({ id: 'u', partId: null, status: 'empty', confidence: 0 })]);
    const next = chooseCandidate(s, ['u'], cand('3001', 0.4), part('3001'));
    expect(reviewLines(next).map((l) => [l.key, l.kind])).toEqual([['p:3001|4', 'ok']]);
    expect(next.pieces[0].identification.status).toBe('identified');
  });
});

describe('summary, deltas and session memory', () => {
  const s = createReview([
    piece({ id: 'a' }), piece({ id: 'b', x: 0.5, confidence: 0.6 }),
    piece({ id: 'c', partId: '3020', colorId: 71, y: 0.4, confidence: 0.7 }),
    piece({ id: 'k', partId: '3003', colorId: 1, reliable: false, y: 0.5 }),
    piece({ id: 'x', partial: true, y: 0.6 }),
    piece({ id: 'u', partId: null, confidence: 0, y: 0.7 }),
  ]);
  it('canAdd is false while a colour is to confirm', () => {
    const sum = reviewSummary(s);
    expect(sum).toEqual({ lines: 2, pieces: 3, toVerify: 2, colorToConfirm: 1, unknown: 1, partial: 1, canAdd: false });
    const fixed = setLineColor(s, 'c:3003|1', 1);
    expect(reviewSummary(fixed)).toMatchObject({ lines: 3, pieces: 4, colorToConfirm: 0, canAdd: true });
    expect(reviewSummary(removeLine(s, 'c:3003|1')).canAdd).toBe(true);
  });
  it('toVerify counts unconfirmed review pieces of addable lines only', () => {
    const removed = removeLine(s, 'p:3020|71');
    expect(reviewSummary(removed).toVerify).toBe(1);
    const confirmed = chooseCandidate(s, ['b'], cand('3001', 0.6), part('3001'));
    expect(reviewSummary(confirmed).toVerify).toBe(1);
  });
  it('toDeltas only for addable lines', () => {
    const q = setLineQuantity(s, 'p:3020|71', 5);
    expect(toDeltas(q, 'L1')).toEqual([
      { listId: 'L1', partId: '3001', colorId: 4, delta: 2 },
      { listId: 'L1', partId: '3020', colorId: 71, delta: 5 },
    ]);
  });
  it('alreadyAdded comes from the session map (itemKey)', () => {
    const lines = reviewLines(s, { '3001|4': 6, '3003|1': 2 });
    expect(lines.find((l) => l.key === 'p:3001|4')!.alreadyAdded).toBe(6);
    expect(lines.find((l) => l.key === 'p:3020|71')!.alreadyAdded).toBe(0);
    expect(lines.find((l) => l.key === 'c:3003|1')!.alreadyAdded).toBe(0);
    expect(lines.find((l) => l.key === 'p:3001|4')!.addable).toBe(true);
    expect(lines.find((l) => l.key === 'u:u')!.addable).toBe(false);
  });
});
