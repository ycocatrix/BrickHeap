import {
  acceptsBricklinkId, isFresh, notFoundRow, pickPrimary, suffixProbeIds, sumSetQuantity, toPartRow, toWireColor,
  toWirePart, validateIds, validateInt, type RbPart,
} from '../../../../supabase/functions/_shared/mapping';

const rb = (part_num: string, extra: Partial<RbPart> = {}): RbPart => ({
  part_num, name: `Part ${part_num}`, part_cat_id: 11, part_img_url: null, year_from: 2000, year_to: 2020, print_of: null,
  ...extra,
});

describe('pickPrimary', () => {
  it('prefers the exact part_num match', () => {
    const r = pickPrimary('3001', [rb('3556'), rb('3001')]);
    expect(r?.primary.part_num).toBe('3001');
    expect(r?.alternates).toEqual(['3556']);
  });
  it('takes the single result', () => {
    const r = pickPrimary('3062', [rb('3062b')]);
    expect(r?.primary.part_num).toBe('3062b');
    expect(r?.alternates).toEqual([]);
  });
  it('without exact match, picks an unprinted part with the latest year_to', () => {
    const r = pickPrimary('44302', [
      rb('44302a', { year_to: 2008 }),
      rb('54657', { year_to: 2026, print_of: '44302b' }),
      rb('44302b', { year_to: 2024 }),
    ]);
    expect(r?.primary.part_num).toBe('44302b');
    expect(r?.alternates).toEqual(['44302a', '54657']);
  });
  it('falls back to all results when every result is a print', () => {
    expect(pickPrimary('x', [rb('a', { print_of: 'p', year_to: 1 }), rb('b', { print_of: 'p', year_to: 9 })])?.primary.part_num).toBe('b');
  });
  it('returns null for no result', () => {
    expect(pickPrimary('3001', [])).toBeNull();
  });
});

describe('validateIds', () => {
  it('accepts 1..max distinct ids matching the charset, de-duplicated', () => {
    expect(validateIds(['3001', '3062', '3001', 'a.b_c-d'], 50)).toEqual(['3001', '3062', 'a.b_c-d']);
  });
  it('rejects bad input', () => {
    expect(validateIds([], 50)).toBeNull();
    expect(validateIds('3001', 50)).toBeNull();
    expect(validateIds(['bad id'], 50)).toBeNull();
    expect(validateIds(['x'.repeat(31)], 50)).toBeNull();
    expect(validateIds([3001], 50)).toBeNull();
    expect(validateIds(Array.from({ length: 51 }, (_, i) => `p${i}`), 50)).toBeNull();
    expect(validateIds(Array.from({ length: 50 }, (_, i) => `p${i}`), 50)).toHaveLength(50);
  });
  it('validates integers', () => {
    expect(validateInt(4, 0, 99999)).toBe(4);
    expect(validateInt('2', 1, 50)).toBe(2);
    expect(validateInt(51, 1, 50)).toBeNull();
    expect(validateInt(1.5, 0, 9)).toBeNull();
    expect(validateInt(null, 0, 9)).toBeNull();
  });
});

describe('row mapping', () => {
  it('maps a Rebrickable part to a parts_cache row', () => {
    const p = rb('3001', {
      name: 'Brick 2 x 4', part_img_url: 'https://cdn/3001.jpg', year_from: 1979, year_to: 2026,
      external_ids: { BrickLink: ['3001'], LEGO: ['15589', '3001'] },
    });
    expect(toPartRow(p, '2026-11-15T00:00:00.000Z')).toEqual({
      part_id: '3001', name: 'Brick 2 x 4', part_cat_id: 11, image_url: 'https://cdn/3001.jpg',
      bricklink_ids: ['3001'], lego_ids: ['15589', '3001'], print_of: null, year_from: 1979, year_to: 2026,
      found: true, fetched_at: '2026-11-15T00:00:00.000Z',
    });
    expect(toWirePart(toPartRow(p, 'x'))).not.toHaveProperty('found');
  });
  it('handles missing optional fields', () => {
    const row = toPartRow({ part_num: 'x', name: 'X', part_cat_id: null, part_img_url: null }, 't');
    expect(row).toMatchObject({ bricklink_ids: [], lego_ids: [], print_of: null, year_from: null, year_to: null });
    expect(notFoundRow('zz', 't')).toMatchObject({ part_id: 'zz', found: false });
  });
  it('accepts a BrickLink id when missing or listed', () => {
    expect(acceptsBricklinkId(rb('3001'), '3001')).toBe(true);
    expect(acceptsBricklinkId(rb('3001', { external_ids: { BrickLink: [] } }), '3001')).toBe(true);
    expect(acceptsBricklinkId(rb('3001', { external_ids: { BrickLink: ['3001', '3001b'] } }), '3001b')).toBe(true);
    expect(acceptsBricklinkId(rb('4073', { external_ids: { BrickLink: ['6141'] } }), '4073')).toBe(false);
  });
  it('checks freshness', () => {
    const now = Date.parse('2026-11-15T00:00:00Z');
    expect(isFresh('2026-11-10T00:00:00Z', 7, now)).toBe(true);
    expect(isFresh('2026-11-01T00:00:00Z', 7, now)).toBe(false);
    expect(isFresh('garbage', 7, now)).toBe(false);
  });
  it('probes mould letters only for ids ending with a digit', () => {
    expect(suffixProbeIds('2412')).toEqual(['2412a', '2412b', '2412c', '2412d']);
    expect(suffixProbeIds('3001special')).toEqual([]);
  });
  it('maps palette colours and sums set quantities', () => {
    expect(toWireColor({ id: 4, name: 'Red', rgb: 'c91a09', is_trans: false, external_ids: { BrickLink: { ext_ids: [5] } } }))
      .toEqual({ color_id: 4, name: 'Red', hex: 'C91A09', is_trans: false, bricklink_id: 5 });
    expect(toWireColor({ id: 9999, name: 'Any', rgb: null, is_trans: false })).toBeNull();
    expect(sumSetQuantity([
      { part: { part_num: '3001' }, color: { id: 4 }, quantity: 10, is_spare: false },
      { part: { part_num: '3001' }, color: { id: 4 }, quantity: 6, is_spare: false },
      { part: { part_num: '3001' }, color: { id: 4 }, quantity: 1, is_spare: true },
      { part: { part_num: '3001' }, color: { id: 1 }, quantity: 3, is_spare: false },
    ], '3001', 4)).toBe(16);
  });
});
