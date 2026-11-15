import { isPseudoItem, parseBoundingBox, parseBrickognizeResponse, retryDelayMs } from '../brickognizeParse';
import { calibrateScore } from '../thresholds';

const REAL = {
  listing_id: 'res-12911859dfdc46bc',
  bounding_box: { left: 9.09, upper: 39.9, right: 182.9, lower: 151.4, image_width: 192.0, image_height: 192.0, score: 0.979 },
  items: [
    { id: '3001', name: 'Brick 2 x 4', img_url: 'https://storage.googleapis.com/brickognize-static/thumbnails/v5.0/part/3001/5.webp',
      external_sites: [{ name: 'bricklink', url: 'https://www.bricklink.com/v2/catalog/catalogitem.page?P=3001' }],
      category: 'Brick', type: 'part', score: 0.652 },
    { id: '3001special', name: 'Brick 2 x 4 special (special bricks, test bricks and/or prototypes)', category: 'Brick',
      type: 'part', score: 0.544 },
  ],
  colors: [{ id: '5', name: 'Red', score: 0.848 }, { id: '17', name: 'Trans-Red', score: 0.221 },
    { id: '11', name: 'Black', score: 0.2 }],
};
const EMPTY = { listing_id: 'res-x', bounding_box: { left: 0, upper: 0, right: 0, lower: 0, image_width: 0, image_height: 0, score: 0 },
  items: [], colors: [] };

describe('isPseudoItem', () => {
  it('flags special items only', () => {
    expect(isPseudoItem('3001special')).toBe(true);
    expect(isPseudoItem('3001')).toBe(false);
    expect(isPseudoItem('3062b')).toBe(false);
  });
});

describe('parseBrickognizeResponse', () => {
  it('parses the real response', () => {
    const r = parseBrickognizeResponse(REAL);
    expect(r.status).toBe('identified');
    expect(r.error).toBeNull();
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toEqual({
      bricklinkId: '3001', name: 'Brick 2 x 4', imageUrl: REAL.items[0].img_url, category: 'Brick', rawScore: 0.652,
      confidence: calibrateScore(0.652),
    });
    expect(r.colors.map((c) => c.bricklinkColorId)).toEqual([5, 17, 11]);
    expect(r.colors[0]).toEqual({ bricklinkColorId: 5, name: 'Red', score: 0.848 });
    expect(r.boxScore).toBe(0.979);
  });
  it('sorts by score and keeps at most 3', () => {
    const r = parseBrickognizeResponse({ items: [
      { id: 'a', score: 0.3 }, { id: 'b', score: 0.9 }, { id: 'c', score: 0.5 }, { id: 'd', score: 0.7 }] });
    expect(r.candidates.map((c) => c.bricklinkId)).toEqual(['b', 'd', 'c']);
    expect(r.colors).toEqual([]);
  });
  it('empty response → empty', () => {
    expect(parseBrickognizeResponse(EMPTY)).toEqual({ status: 'empty', candidates: [], colors: [], boxScore: 0, error: null });
  });
  it('only pseudo-items → empty', () => {
    expect(parseBrickognizeResponse({ items: [REAL.items[1]] }).status).toBe('empty');
  });
  it.each([[null], ['oops'], [{ listing_id: 'x' }], [{ items: 'nope' }], [[]]])('%p → unavailable', (json) => {
    expect(parseBrickognizeResponse(json)).toEqual(
      { status: 'unavailable', candidates: [], colors: [], boxScore: 0, error: 'server' });
  });
  it('missing colors → identified with colors []', () => {
    const { colors: _colors, ...noColors } = REAL;
    const r = parseBrickognizeResponse(noColors);
    expect(r.status).toBe('identified');
    expect(r.colors).toEqual([]);
  });
  it('malformed colour entries are dropped', () => {
    const r = parseBrickognizeResponse({ ...REAL, colors: [{ id: 'x', score: 1 }, null, { id: 9, score: 0.4 }] });
    expect(r.colors).toEqual([{ bricklinkColorId: 9, name: '', score: 0.4 }]);
  });
});

describe('parseBoundingBox', () => {
  it('normalises with image_width / image_height', () => {
    const b = parseBoundingBox(REAL);
    expect(b).not.toBeNull();
    expect(b!.x).toBeCloseTo(9.09 / 192, 6);
    expect(b!.y).toBeCloseTo(39.9 / 192, 6);
    expect(b!.w).toBeCloseTo((182.9 - 9.09) / 192, 6);
    expect(b!.h).toBeCloseTo((151.4 - 39.9) / 192, 6);
  });
  it('degenerate box → null', () => {
    expect(parseBoundingBox(EMPTY)).toBeNull();
    expect(parseBoundingBox(null)).toBeNull();
  });
});

describe('retryDelayMs', () => {
  it('prefers x-retry-in', () => {
    expect(retryDelayMs('54.075562ms', '1')).toBeCloseTo(54.075562, 6);
  });
  it('falls back to retry-after seconds', () => {
    expect(retryDelayMs(null, '1')).toBe(1000);
    expect(retryDelayMs('garbage', '2')).toBe(2000);
  });
  it('null when nothing usable', () => {
    expect(retryDelayMs(null, null)).toBeNull();
  });
});
