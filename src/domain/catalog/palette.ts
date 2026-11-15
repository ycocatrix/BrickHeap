// Pure palette construction (D6). Re-exported by src/services/catalog.ts as `buildPalette`.
import type { CatalogCategory, CatalogColor, ColorId, Palette } from '../types';

/** Builds the Palette maps from colours + categories. Ids −1 and 9999 are dropped; colours sorted by id.
 *  byBricklinkId is deterministic: on a collision the LOWEST Rebrickable id wins. */
export function buildPalette(colors: readonly CatalogColor[], categories: readonly CatalogCategory[]): Palette {
  const list = colors
    .filter((c) => c.colorId !== -1 && c.colorId !== 9999)
    .slice()
    .sort((a, b) => a.colorId - b.colorId);
  const byId = new Map<ColorId, CatalogColor>();
  const byBricklinkId = new Map<number, CatalogColor>();
  for (const c of list) {
    byId.set(c.colorId, c);
    if (c.bricklinkId !== null && !byBricklinkId.has(c.bricklinkId)) byBricklinkId.set(c.bricklinkId, c);
  }
  const cats = categories.slice().sort((a, b) => a.id - b.id);
  return {
    colors: list,
    categories: cats,
    byId,
    byBricklinkId,
    categoryName: new Map(cats.map((c) => [c.id, c.name])),
  };
}

/** Validates the seed / proxy palette shape; malformed entries are dropped. */
export function parsePaletteJson(json: unknown): { colors: CatalogColor[]; categories: CatalogCategory[] } {
  const o = (typeof json === 'object' && json !== null ? json : {}) as { colors?: unknown; categories?: unknown };
  const colors: CatalogColor[] = [];
  for (const c of Array.isArray(o.colors) ? o.colors : []) {
    if (typeof c !== 'object' || c === null) continue;
    const r = c as Record<string, unknown>;
    // Accept both the seed shape (camelCase) and the proxy wire shape (snake_case).
    const colorId = r.colorId ?? r.color_id;
    const hex = r.hex;
    const name = r.name;
    if (typeof colorId !== 'number' || typeof name !== 'string' || typeof hex !== 'string') continue;
    const bl = r.bricklinkId ?? r.bricklink_id;
    colors.push({
      colorId,
      name,
      hex: hex.replace(/^#/, '').toUpperCase(),
      isTrans: (r.isTrans ?? r.is_trans) === true,
      bricklinkId: typeof bl === 'number' ? bl : null,
    });
  }
  const categories: CatalogCategory[] = [];
  for (const c of Array.isArray(o.categories) ? o.categories : []) {
    if (typeof c !== 'object' || c === null) continue;
    const r = c as Record<string, unknown>;
    if (typeof r.id === 'number' && typeof r.name === 'string') categories.push({ id: r.id, name: r.name });
  }
  return { colors, categories };
}
