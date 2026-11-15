import seed from '../../../data/seed/palette.json';
import { buildPalette, parsePaletteJson } from '../palette';
import { CATEGORY_NAMES_FR } from '../../../i18n/fr/catalog';

describe('seed palette', () => {
  const parsed = parsePaletteJson(seed);
  const palette = buildPalette(parsed.colors, parsed.categories);

  it('has only the documented keys and enough entries', () => {
    expect(Object.keys(seed).sort()).toEqual(['categories', 'colors', 'generatedAt']);
    expect(parsed.colors.length).toBeGreaterThanOrEqual(270);
    expect(parsed.colors).toHaveLength(seed.colors.length); // every seed entry is well-formed
    expect(parsed.categories).toHaveLength(76);
  });

  it('resolves BrickLink collisions to the lowest Rebrickable id', () => {
    expect(palette.byBricklinkId.get(77)?.colorId).toBe(148);
    expect(palette.byBricklinkId.get(72)?.colorId).toBe(313);
    expect(palette.byBricklinkId.get(5)?.colorId).toBe(4); // Red
  });

  it('excludes ids -1 and 9999', () => {
    expect(palette.byId.has(-1)).toBe(false);
    expect(palette.byId.has(9999)).toBe(false);
  });

  it('uses 6 upper-case hex digits', () => {
    for (const c of palette.colors) expect(c.hex).toMatch(/^[0-9A-F]{6}$/);
    expect(palette.byId.get(4)?.hex).toBe('C91A09');
  });

  it('has a French name for every category of the seed', () => {
    for (const c of palette.categories) expect(CATEGORY_NAMES_FR[c.id]).toEqual(expect.any(String));
    expect(palette.categoryName.get(11)).toBe('Bricks');
  });
});

describe('buildPalette', () => {
  it('is deterministic whatever the input order', () => {
    const a = { colorId: 1103, name: 'Pearl Titanium', hex: '3E3C39', isTrans: false, bricklinkId: 77 };
    const b = { colorId: 148, name: 'Pearl Dark Gray', hex: '575857', isTrans: false, bricklinkId: 77 };
    const junk = { colorId: 9999, name: '[No Color]', hex: '05131D', isTrans: false, bricklinkId: 0 };
    const p = buildPalette([a, junk, b], [{ id: 2, name: 'B' }, { id: 1, name: 'A' }]);
    expect(p.byBricklinkId.get(77)?.colorId).toBe(148);
    expect(p.colors.map((c) => c.colorId)).toEqual([148, 1103]);
    expect(p.categories.map((c) => c.id)).toEqual([1, 2]);
    expect(p.byBricklinkId.has(0)).toBe(false);
  });

  it('parses the proxy wire shape', () => {
    const parsed = parsePaletteJson({
      colors: [{ color_id: 4, name: 'Red', hex: 'c91a09', is_trans: false, bricklink_id: 5 }, { bad: true }],
      categories: [{ id: 1, name: 'Baseplates' }, { id: 'x' }],
      stale: false,
    });
    expect(parsed.colors).toEqual([{ colorId: 4, name: 'Red', hex: 'C91A09', isTrans: false, bricklinkId: 5 }]);
    expect(parsed.categories).toEqual([{ id: 1, name: 'Baseplates' }]);
  });
});
