import { parseDetailResponse, parsePartColorsResponse, parsePartsResponse, parseSetQtyResponse, wireToPart } from '../wire';

describe('catalog-proxy wire parsing', () => {
  it('parses a parts response', () => {
    const m = parsePartsResponse({
      parts: {
        '3062': { status: 'found', part: {
          part_id: '3062b', name: 'Brick Round 1 x 1', part_cat_id: 20, image_url: 'u', bricklink_ids: ['3062b'],
          lego_ids: ['3062'], print_of: null, year_from: 1979, year_to: 2026 } },
        '3001special': { status: 'not_found' },
        '99999': { status: 'pending' },
        broken: { status: 'found', part: {} },
      },
      stale: false,
    });
    expect(m?.get('3062')).toEqual({ status: 'found', part: {
      partId: '3062b', name: 'Brick Round 1 x 1', categoryId: 20, imageUrl: 'u', bricklinkIds: ['3062b'], legoIds: ['3062'],
      printOf: null, yearFrom: 1979, yearTo: 2026, source: 'rebrickable', resolution: 'resolved' } });
    expect(m?.get('3001special')).toEqual({ status: 'not_found' });
    expect(m?.get('99999')).toEqual({ status: 'pending' });
    expect(m?.has('broken')).toBe(false);
    expect(parsePartsResponse({ error: 'upstream' })).toBeNull();
    expect(parsePartsResponse(null)).toBeNull();
  });

  it('maps year 0 to null', () => {
    expect(wireToPart({ part_id: 'x', name: 'X', year_from: 0, year_to: 0 })).toMatchObject({ yearFrom: null, yearTo: null });
  });

  it('parses part_colors, detail and set_qty', () => {
    const pc = parsePartColorsResponse({ parts: { '3001': [{ color_id: 1, image_url: null, element_ids: ['300123'], num_sets: 5 }, { x: 1 }] } });
    expect(pc?.get('3001')).toEqual([{ colorId: 1, imageUrl: null, elementIds: ['300123'], numSets: 5 }]);

    const d = parseDetailResponse({
      part_color: { part_id: '3001', color_id: 4, found: true, element_ids: ['300121'], image_url: 'i', num_sets: 1016 },
      sets: { total: 1133, page: 1, page_size: 100, sets: [
        { set_num: '10018-1', name: 'Darth Maul', year: 2001, num_parts: 1868, image_url: null }, { nope: 1 }] },
      stale: true,
    }, '3001', 4);
    expect(d).toEqual({
      partColor: { partId: '3001', colorId: 4, found: true, elementIds: ['300121'], imageUrl: 'i', numSets: 1016 },
      sets: { total: 1133, page: 1, pageSize: 100, sets: [{ setNum: '10018-1', name: 'Darth Maul', year: 2001, numParts: 1868, imageUrl: null }] },
      stale: true,
    });
    expect(parseDetailResponse({ part_color: { found: false }, sets: null }, 'p', 1)?.sets).toBeNull();
    expect(parseDetailResponse({}, 'p', 1)).toBeNull();

    expect(parseSetQtyResponse({ quantity: 16, stale: false })).toBe(16);
    expect(parseSetQtyResponse({ quantity: null })).toBeNull();
    expect(parseSetQtyResponse({})).toBeUndefined();
  });
});
