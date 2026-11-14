import type { CatalogColor, CatalogPart, InventoryFilter, InventoryRow, ItemDelta } from '../../types';
import {
  filterAndGroup, fold, inventoryTotals, mergeDeltas, validateListName, type StoredItem,
} from '../inventory';

// partInfo belongs to WP5 (developed in parallel); a minimal stand-in keeps these tests independent of it while
// still checking that search and grouping go through partLabel / categoryLabel.
jest.mock('../../catalog/partInfo', () => {
  const WORDS: [string, string][] = [['Brick', 'Brique'], ['Plate', 'Plaque'], ['Tile', 'Tuile']];
  const CATS: Record<number, string> = { 11: 'Briques', 14: 'Plaques' };
  return {
    partLabel: (name: string) => {
      let out = name.replace(/ x /g, ' × ');
      for (const [en, fr] of WORDS) if (out.startsWith(en + ' ')) out = fr + out.slice(en.length);
      return out;
    },
    categoryLabel: (id: number | null, fallback: string | null) => (id === null ? null : CATS[id] ?? fallback),
  };
});

const NOW = '2026-11-15T10:00:00.000Z';
const OLD = '2026-11-01T10:00:00.000Z';

function item(partId: string, colorId: number, quantity: number, base = 0, listId = 'L1'): StoredItem {
  return { listId, partId, colorId, quantity, base_quantity: base, updatedAt: OLD };
}
function d(partId: string, colorId: number, delta: number, listId = 'L1'): ItemDelta {
  return { listId, partId, colorId, delta };
}

describe('mergeDeltas', () => {
  it('creates a missing key with base_quantity 0', () => {
    const r = mergeDeltas([], [d('3001', 4, 3)], NOW);
    expect(r.items).toEqual([{ listId: 'L1', partId: '3001', colorId: 4, quantity: 3, base_quantity: 0, updatedAt: NOW }]);
    expect(r.deleted).toEqual([]);
    expect(r.applied.applied).toEqual([d('3001', 4, 3)]);
    expect(r.applied.inverse).toEqual([d('3001', 4, -3)]);
  });

  it('increments an existing key (RG_08) and carries base_quantity through', () => {
    const r = mergeDeltas([item('3001', 4, 2, 5)], [d('3001', 4, 3)], NOW);
    expect(r.items).toEqual([{ ...item('3001', 4, 5, 5), updatedAt: NOW }]);
  });

  it('sums several deltas on one key first', () => {
    const r = mergeDeltas([item('3001', 4, 1)], [d('3001', 4, 2), d('3001', 4, 4), d('3001', 4, -1)], NOW);
    expect(r.items[0].quantity).toBe(6);
    expect(r.applied.applied).toEqual([d('3001', 4, 5)]);
  });

  it('floors a negative delta at 0 and removes the row when base is 0 (RG_10)', () => {
    const r = mergeDeltas([item('3001', 4, 2)], [d('3001', 4, -5)], NOW);
    expect(r.items).toEqual([]);
    expect(r.deleted).toEqual([{ listId: 'L1', partId: '3001', colorId: 4 }]);
    expect(r.applied.applied).toEqual([d('3001', 4, -2)]);
    expect(r.applied.inverse).toEqual([d('3001', 4, 2)]);
  });

  it('keeps a row at quantity 0 when base_quantity > 0 (tombstone), not reported as deleted', () => {
    const r = mergeDeltas([item('3001', 4, 2, 2)], [d('3001', 4, -2)], NOW);
    expect(r.items).toEqual([{ ...item('3001', 4, 0, 2), updatedAt: NOW }]);
    expect(r.deleted).toEqual([]);
  });

  it('caps at 100000', () => {
    const r = mergeDeltas([item('3001', 4, 99990)], [d('3001', 4, 50)], NOW);
    expect(r.items[0].quantity).toBe(100000);
    expect(r.applied.applied).toEqual([d('3001', 4, 10)]);
  });

  it('a negative delta on a missing key creates nothing', () => {
    const r = mergeDeltas([], [d('3001', 4, -3)], NOW);
    expect(r).toEqual({ items: [], deleted: [], applied: { applied: [], inverse: [] } });
  });

  it('inverse restores the original state exactly, including a floored delta', () => {
    const start = [item('3001', 4, 2), item('3003', 1, 7, 3), item('3020', 15, 1, 0, 'L2')];
    const deltas = [d('3001', 4, -10), d('3003', 1, 5), d('3020', 15, 2, 'L2'), d('3666', 0, 4)];
    const first = mergeDeltas(start, deltas, NOW);
    const back = mergeDeltas(first.items, first.applied.inverse, NOW);
    const strip = (rows: StoredItem[]) =>
      rows.map(({ updatedAt: _u, ...rest }) => rest).sort((a, b) => a.partId.localeCompare(b.partId));
    // 3001 was floored (−2 applied, row deleted) and 3666 created; undo recreates / removes them exactly
    expect(first.deleted).toEqual([{ listId: 'L1', partId: '3001', colorId: 4 }]);
    expect(first.applied.inverse).toContainEqual(d('3001', 4, 2));
    expect(strip(back.items)).toEqual(strip(start));
    expect(back.deleted).toEqual([{ listId: 'L1', partId: '3666', colorId: 0 }]);
  });

  it('leaves untouched rows unchanged', () => {
    const r = mergeDeltas([item('3001', 4, 2), item('3003', 1, 1)], [d('3003', 1, 1)], NOW);
    expect(r.items).toContainEqual(item('3001', 4, 2));
  });
});

describe('validateListName', () => {
  it('trims and accepts a valid name', () => {
    expect(validateListName('  Vrac salon ', ['Mon inventaire'])).toEqual({ ok: true, value: 'Vrac salon' });
  });
  it('refuses an empty name', () => {
    const r = validateListName('   ', []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid');
  });
  it('accepts 60 characters and refuses 61', () => {
    expect(validateListName('a'.repeat(60), []).ok).toBe(true);
    const r = validateListName('a'.repeat(61), []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('60');
  });
  it('refuses a duplicate with different case or accents', () => {
    expect(validateListName('mon inventaire', ['Mon inventaire']).ok).toBe(false);
    expect(validateListName('Projet Élodie', ['projet elodie']).ok).toBe(false);
    expect(validateListName('Projet Elodie', ['  PROJET ÉLODIE ']).ok).toBe(false);
  });
});

describe('fold', () => {
  it('lower-cases and strips accents', () => {
    expect(fold('Élodie À Ça Œuvre 2 × 4')).toBe('elodie a ca oeuvre 2 x 4');
  });
});

const RED: CatalogColor = { colorId: 4, name: 'Red', hex: 'C91A09', isTrans: false, bricklinkId: 5 };
const BLUE: CatalogColor = { colorId: 1, name: 'Blue', hex: '0055BF', isTrans: false, bricklinkId: 7 };
const WHITE: CatalogColor = { colorId: 15, name: 'White', hex: 'FFFFFF', isTrans: false, bricklinkId: 1 };

function part(partId: string, name: string, categoryId: number | null): CatalogPart {
  return {
    partId, name, categoryId, imageUrl: null, bricklinkIds: [partId], legoIds: [], printOf: null, yearFrom: null,
    yearTo: null, source: 'rebrickable', resolution: 'resolved',
  };
}

function row(p: CatalogPart | null, partId: string, color: CatalogColor | null, colorId: number, quantity: number,
  listId = 'L1', listName = 'Mon inventaire', categoryName: string | null = null): InventoryRow {
  return {
    listId, partId, colorId, quantity, updatedAt: OLD, listName, part: p, color, imageUrl: null, coloredImage: false,
    categoryName,
  };
}

const ROWS: InventoryRow[] = [
  row(part('3001', 'Brick 2 x 4', 11), '3001', RED, 4, 3, 'L1', 'Mon inventaire', 'Briques'),
  row(part('3020', 'Plate 2 x 4', 14), '3020', BLUE, 1, 2, 'L1', 'Mon inventaire', 'Plaques'),
  row(part('3003', 'Brick 2 x 2', 11), '3003', WHITE, 15, 5, 'L2', 'Vrac salon', 'Briques'),
  row(null, '99999', null, 999, 1, 'L2', 'Vrac salon', null),
];

const F = (patch: Partial<InventoryFilter>): InventoryFilter =>
  ({ listId: null, query: '', colorIds: [], categoryIds: [], groupBy: 'none', ...patch });

const ids = (sections: ReturnType<typeof filterAndGroup>) => sections.flatMap((s) => s.rows.map((r) => r.partId));

describe('filterAndGroup', () => {
  it('without filter returns one section "all" sorted by name', () => {
    const s = filterAndGroup(ROWS, F({}));
    expect(s).toHaveLength(1);
    expect(s[0].key).toBe('all');
    expect(ids(s)).toEqual(['99999', '3003', '3001', '3020']);
  });

  it('« brique », « Brique » and « brick » match bricks (partLabel and official name)', () => {
    for (const q of ['brique', 'Brique', 'brick', 'BRIQUE 2 × 4']) {
      expect(ids(filterAndGroup(ROWS, F({ query: q })))).toEqual(q.includes('4') ? ['3001'] : ['3003', '3001']);
    }
  });

  it('matches colour names in French and English, part ids and category names, ignoring accents', () => {
    expect(ids(filterAndGroup(ROWS, F({ query: 'rouge' })))).toEqual(['3001']);
    expect(ids(filterAndGroup(ROWS, F({ query: 'blue' })))).toEqual(['3020']);
    expect(ids(filterAndGroup(ROWS, F({ query: '3020' })))).toEqual(['3020']);
    expect(ids(filterAndGroup(ROWS, F({ query: 'plaques' })))).toEqual(['3020']);
    expect(ids(filterAndGroup(ROWS, F({ query: 'PLAQUE' })))).toEqual(['3020']);
  });

  it('no match → no section', () => {
    expect(filterAndGroup(ROWS, F({ query: 'zzz' }))).toEqual([]);
  });

  it('filters by colour and by category', () => {
    expect(ids(filterAndGroup(ROWS, F({ colorIds: [4, 15] })))).toEqual(['3003', '3001']);
    expect(ids(filterAndGroup(ROWS, F({ categoryIds: [14] })))).toEqual(['3020']);
  });

  it('filters by list', () => {
    expect(ids(filterAndGroup(ROWS, F({ listId: 'L2' })))).toEqual(['99999', '3003']);
  });

  it('groups by category with French titles', () => {
    const s = filterAndGroup(ROWS, F({ groupBy: 'category' }));
    expect(s.map((x) => x.title)).toEqual(['Briques', 'Plaques', 'Sans catégorie']);
    expect(s[0].rows.map((r) => r.partId)).toEqual(['3003', '3001']);
  });

  it('groups by colour with French colour names', () => {
    const s = filterAndGroup(ROWS, F({ groupBy: 'color' }));
    expect(s.map((x) => x.title)).toEqual(['Blanc', 'Bleu', 'Couleur 999', 'Rouge']);
  });

  it('groups by list', () => {
    const s = filterAndGroup(ROWS, F({ groupBy: 'list' }));
    expect(s.map((x) => [x.key, x.title, x.rows.length])).toEqual([
      ['list:L1', 'Mon inventaire', 2],
      ['list:L2', 'Vrac salon', 2],
    ]);
  });

  it('never shows rows with quantity 0', () => {
    expect(ids(filterAndGroup([row(null, 'x', null, 0, 0)], F({})))).toEqual([]);
  });
});

describe('inventoryTotals', () => {
  it('counts references and pieces', () => {
    expect(inventoryTotals(ROWS)).toEqual({ refs: 4, pieces: 11 });
    expect(inventoryTotals([])).toEqual({ refs: 0, pieces: 0 });
  });
});
