import { groupPieces, lineCandidates } from '../grouping';
import { cand, piece } from '../testing/fixtures';

jest.mock('../../catalog/partInfo', () => jest.requireActual('../testing/fixtures').partInfoMock);

const pile = () => [
  piece({ id: 'a', partId: '3001', colorId: 4, x: 0.1, y: 0.1 }),
  piece({ id: 'b', partId: '3001', colorId: 4, x: 0.5, y: 0.1, confidence: 0.85 }),
  piece({ id: 'c', partId: '3001', colorId: 4, x: 0.1, y: 0.5 }),
  piece({ id: 'd', partId: '3020', colorId: 71, x: 0.3, y: 0.3 }),
  piece({ id: 'e', partId: '3020', colorId: 71, x: 0.7, y: 0.7 }),
];

describe('groupPieces', () => {
  it('3 × (3001, red) + 2 × (3020, grey) → two ok groups', () => {
    const g = groupPieces(pile());
    expect(g.map((x) => [x.key, x.kind, x.count])).toEqual([['p:3001|4', 'ok', 3], ['p:3020|71', 'ok', 2]]);
    expect(g[0].detectionIds).toEqual(['a', 'b', 'c']);
    expect(g[0].partId).toBe('3001');
    expect(g[0].colorId).toBe(4);
    expect(g[0].name).toBe('Part 3001');
    expect(g[0].provisional).toBe(false);
  });
  it('group confidence is the minimum of its members', () => {
    const g = groupPieces(pile());
    expect(g[0].confidence).toBe(0.85);
    expect(g[0].level).toBe('accepted');
  });
  it('an unreliable colour forms a separate color_to_confirm group', () => {
    const g = groupPieces([...pile(), piece({ id: 'f', partId: '3001', colorId: 4, reliable: false, y: 0.9 }),
      piece({ id: 'g', partId: '3001', colorId: null, reliable: false, y: 0.95 })]);
    expect(g.map((x) => [x.key, x.kind])).toEqual([
      ['p:3001|4', 'ok'], ['p:3020|71', 'ok'], ['c:3001|4', 'color_to_confirm'], ['c:3001|?', 'color_to_confirm']]);
  });
  it('partial and unknown pieces are single groups, after the others, top to bottom', () => {
    const g = groupPieces([
      piece({ id: 'u2', partId: null, level: 'unknown', confidence: 0, y: 0.8 }),
      piece({ id: 'x1', partial: true, y: 0.6 }),
      piece({ id: 'x2', partial: true, y: 0.2 }),
      piece({ id: 'u1', partId: '3001', confidence: 0.3, y: 0.4 }),
      piece({ id: 'ok', y: 0.9 }),
      piece({ id: 'xc', partial: true, partialConfirmed: true, y: 0.95 }),
    ]);
    expect(g.map((x) => x.key)).toEqual(['p:3001|4', 'x:x2', 'x:x1', 'u:u1', 'u:u2']);
    expect(g[0].count).toBe(2);
    const unknown = g.find((x) => x.key === 'u:u1')!;
    expect(unknown.kind).toBe('unknown');
    expect(unknown.name).toBe('');
    expect(unknown.partId).toBeNull();
  });
  it('pending, empty and unavailable pieces are unknown', () => {
    const g = groupPieces([
      piece({ id: 'p', partId: null, status: 'pending', confidence: 0 }),
      piece({ id: 'e', partId: null, status: 'empty', confidence: 0 }),
      piece({ id: 'n', partId: null, status: 'unavailable', confidence: 0 }),
    ]);
    expect(g.every((x) => x.kind === 'unknown' && x.key.startsWith('u:'))).toBe(true);
  });
  it('a provisional part is grouped like a resolved one', () => {
    const g = groupPieces([
      piece({ id: 'a', partId: '3062', partSource: 'brickognize' }),
      piece({ id: 'b', partId: '3062', partSource: 'brickognize', x: 0.6 }),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].key).toBe('p:3062|4');
    expect(g[0].kind).toBe('ok');
    expect(g[0].provisional).toBe(true);
  });
  it('cropUri is the first member\'s crop', () => {
    const g = groupPieces([
      piece({ id: 'a', x: 0.1, cropUri: null }),
      piece({ id: 'b', x: 0.5, cropUri: 'file:///b.jpg' }),
      piece({ id: 'c', x: 0.9, cropUri: 'file:///c.jpg' }),
    ]);
    expect(g[0].cropUri).toBe('file:///b.jpg');
  });
  it('is deterministic for shuffled input', () => {
    const base = [...pile(), piece({ id: 'f', partId: '3003', colorId: 1, y: 0.2 }),
      piece({ id: 'g', partId: '3002', colorId: 1, y: 0.25 }), piece({ id: 'u', partId: null, confidence: 0 })];
    const ref = groupPieces(base);
    // ok groups with equal count are sorted by name
    expect(ref.map((x) => x.key)).toEqual(['p:3001|4', 'p:3020|71', 'p:3002|1', 'p:3003|1', 'u:u']);
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 20; i++) {
      const shuffled = [...base].sort(() => rnd() - 0.5);
      expect(groupPieces(shuffled)).toEqual(ref);
    }
  });
});

describe('lineCandidates', () => {
  it('unions candidates by bricklinkId with the max score, best first, at most 5', () => {
    const pieces = [
      piece({ id: 'a', candidates: [cand('3001', 0.7), cand('3002', 0.5), cand('3003', 0.4)] }),
      piece({ id: 'b', candidates: [cand('3002', 0.8), cand('3004', 0.3), cand('3005', 0.2)] }),
      piece({ id: 'c', candidates: [cand('3006', 0.1), cand('3007', 0.05)] }),
      piece({ id: 'z', candidates: [cand('9999', 0.99)] }),
    ];
    const r = lineCandidates(pieces, ['a', 'b', 'c']);
    expect(r.map((c) => [c.bricklinkId, c.rawScore])).toEqual(
      [['3002', 0.8], ['3001', 0.7], ['3003', 0.4], ['3004', 0.3], ['3005', 0.2]]);
  });
});
