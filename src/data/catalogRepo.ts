// Local catalogue cache (catalog_* tables of §4.2). Internal to WP5: the only writer of these tables.
// Every write goes through withWrite; reads use db().
import type { SQLiteDatabase } from 'expo-sqlite';
import type {
  BricklinkId, CatalogCategory, CatalogColor, CatalogPart, ColorId, PartColorInfo, PartId,
} from '@/domain/types';
import { db, withWrite } from './db';
import { setMeta } from './meta';

interface PartRowDb {
  part_id: string; name: string; category_id: number | null; image_url: string | null; bricklink_ids: string;
  lego_ids: string; print_of: string | null; year_from: number | null; year_to: number | null; source: string;
  resolution: string; fetched_at: string;
}
interface PartColorRowDb {
  part_id: string; color_id: number; found: number; element_ids: string; image_url: string | null; num_sets: number;
  fetched_at: string;
}
export interface BlMapEntry { bricklinkId: BricklinkId; partId: PartId | null; fetchedAt: string }
export interface StoredPart { part: CatalogPart; fetchedAt: string }
export interface StoredPartColor { info: PartColorInfo; fetchedAt: string }

function parseArr(s: string | null): string[] {
  if (!s) return [];
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function toPart(r: PartRowDb): CatalogPart {
  const source = r.source === 'brickognize' ? 'brickognize' : 'rebrickable';
  const resolution = source === 'rebrickable' ? 'resolved' : r.resolution === 'not_found' ? 'not_found' : 'pending';
  return {
    partId: r.part_id,
    name: r.name,
    categoryId: r.category_id,
    imageUrl: r.image_url,
    bricklinkIds: parseArr(r.bricklink_ids),
    legoIds: parseArr(r.lego_ids),
    printOf: r.print_of,
    yearFrom: r.year_from,
    yearTo: r.year_to,
    source,
    resolution,
  };
}

function toPartColor(r: PartColorRowDb): StoredPartColor {
  return {
    info: {
      partId: r.part_id,
      colorId: r.color_id,
      found: r.found !== 0,
      elementIds: parseArr(r.element_ids),
      imageUrl: r.image_url,
      numSets: r.num_sets,
    },
    fetchedAt: r.fetched_at,
  };
}

const placeholders = (n: number) => new Array(n).fill('?').join(',');

/** SQLite has a bound-parameter limit: query in slices. */
async function selectIn<T>(sql: (ph: string) => string, ids: readonly string[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 400) {
    const slice = ids.slice(i, i + 400);
    out.push(...(await db().getAllAsync<T>(sql(placeholders(slice.length)), ...slice)));
  }
  return out;
}

async function upsertPartOn(tx: SQLiteDatabase, p: CatalogPart, fetchedAt: string): Promise<void> {
  await tx.runAsync(
    `INSERT INTO catalog_parts (part_id, name, category_id, image_url, bricklink_ids, lego_ids, print_of, year_from,
       year_to, source, resolution, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(part_id) DO UPDATE SET name = excluded.name, category_id = excluded.category_id,
       image_url = excluded.image_url, bricklink_ids = excluded.bricklink_ids, lego_ids = excluded.lego_ids,
       print_of = excluded.print_of, year_from = excluded.year_from, year_to = excluded.year_to,
       source = excluded.source, resolution = excluded.resolution, fetched_at = excluded.fetched_at`,
    p.partId, p.name, p.categoryId, p.imageUrl, JSON.stringify(p.bricklinkIds), JSON.stringify(p.legoIds),
    p.printOf, p.yearFrom, p.yearTo, p.source, p.resolution, fetchedAt,
  );
}

async function upsertBlMapOn(tx: SQLiteDatabase, bricklinkId: string, partId: string | null, fetchedAt: string) {
  await tx.runAsync(
    `INSERT INTO catalog_bl_map (bricklink_id, part_id, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(bricklink_id) DO UPDATE SET part_id = excluded.part_id, fetched_at = excluded.fetched_at`,
    bricklinkId, partId, fetchedAt,
  );
}

// ---------------------------------------------------------------- palette
export async function readPalette(): Promise<{ colors: CatalogColor[]; categories: CatalogCategory[] }> {
  const colors = await db().getAllAsync<{ color_id: number; name: string; hex: string; is_trans: number; bricklink_id: number | null }>(
    'SELECT color_id, name, hex, is_trans, bricklink_id FROM catalog_colors ORDER BY color_id');
  const categories = await db().getAllAsync<{ id: number; name: string }>(
    'SELECT id, name FROM catalog_categories ORDER BY id');
  return {
    colors: colors.map((c) => ({
      colorId: c.color_id, name: c.name, hex: c.hex, isTrans: c.is_trans !== 0, bricklinkId: c.bricklink_id,
    })),
    categories,
  };
}

/** Replaces both palette tables and stamps meta.palette_fetched_at, in one transaction. */
export function writePalette(colors: readonly CatalogColor[], categories: readonly CatalogCategory[], nowIso: string) {
  return withWrite(async (tx) => {
    await tx.runAsync('DELETE FROM catalog_colors');
    await tx.runAsync('DELETE FROM catalog_categories');
    for (const c of colors) {
      await tx.runAsync('INSERT INTO catalog_colors (color_id, name, hex, is_trans, bricklink_id) VALUES (?, ?, ?, ?, ?)',
        c.colorId, c.name, c.hex, c.isTrans ? 1 : 0, c.bricklinkId);
    }
    for (const c of categories) await tx.runAsync('INSERT INTO catalog_categories (id, name) VALUES (?, ?)', c.id, c.name);
    await setMeta('palette_fetched_at', nowIso, tx);
  });
}

// ---------------------------------------------------------------- parts
export async function getPartRows(partIds: readonly PartId[]): Promise<Map<PartId, StoredPart>> {
  const ids = [...new Set(partIds)];
  if (ids.length === 0) return new Map();
  const rows = await selectIn<PartRowDb>((ph) => `SELECT * FROM catalog_parts WHERE part_id IN (${ph})`, ids);
  return new Map(rows.map((r) => [r.part_id, { part: toPart(r), fetchedAt: r.fetched_at }]));
}

export async function getPartRow(partId: PartId): Promise<CatalogPart | null> {
  const r = await db().getFirstAsync<PartRowDb>('SELECT * FROM catalog_parts WHERE part_id = ?', partId);
  return r ? toPart(r) : null;
}

export async function getBlMap(ids: readonly BricklinkId[]): Promise<Map<BricklinkId, BlMapEntry>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await selectIn<{ bricklink_id: string; part_id: string | null; fetched_at: string }>(
    (ph) => `SELECT bricklink_id, part_id, fetched_at FROM catalog_bl_map WHERE bricklink_id IN (${ph})`, unique);
  return new Map(rows.map((r) => [r.bricklink_id, { bricklinkId: r.bricklink_id, partId: r.part_id, fetchedAt: r.fetched_at }]));
}

/** Proxy answers for BrickLink ids: found → part row + map entry; not_found → negative map entry. */
export function saveBricklinkResolutions(found: readonly { bricklinkId: string; part: CatalogPart }[],
  notFound: readonly string[], nowIso: string): Promise<void> {
  if (found.length === 0 && notFound.length === 0) return Promise.resolve();
  return withWrite(async (tx) => {
    for (const f of found) {
      await upsertPartOn(tx, f.part, nowIso);
      await upsertBlMapOn(tx, f.bricklinkId, f.part.partId, nowIso);
    }
    for (const id of notFound) await upsertBlMapOn(tx, id, null, nowIso);
  });
}

/** Stores provisional parts unless a row with that id exists; an existing 'pending' provisional row may become
 *  'not_found'. Returns true when something was written. */
export function saveProvisionalParts(parts: readonly CatalogPart[], nowIso: string): Promise<boolean> {
  if (parts.length === 0) return Promise.resolve(false);
  return withWrite(async (tx) => {
    let changed = false;
    for (const p of parts) {
      const existing = await tx.getFirstAsync<{ source: string; resolution: string }>(
        'SELECT source, resolution FROM catalog_parts WHERE part_id = ?', p.partId);
      if (!existing) {
        await upsertPartOn(tx, p, nowIso);
        changed = true;
      } else if (existing.source === 'brickognize' && existing.resolution === 'pending' && p.resolution === 'not_found') {
        await tx.runAsync("UPDATE catalog_parts SET resolution = 'not_found', fetched_at = ? WHERE part_id = ?", nowIso, p.partId);
        changed = true;
      }
    }
    return changed;
  });
}

/** Upserts resolved parts (rebrickable id lookups). */
export function saveParts(parts: readonly CatalogPart[], nowIso: string): Promise<void> {
  if (parts.length === 0) return Promise.resolve();
  return withWrite(async (tx) => {
    for (const p of parts) await upsertPartOn(tx, p, nowIso);
  });
}

/** Rebrickable said not_found for these ids: placeholder rows (7-day negative cache) where no row exists; existing
 *  provisional rows become 'not_found' with a new fetched_at; resolved rows are left untouched. */
export function markRebrickableNotFound(partIds: readonly PartId[], nowIso: string): Promise<void> {
  if (partIds.length === 0) return Promise.resolve();
  return withWrite(async (tx) => {
    for (const id of partIds) {
      const existing = await tx.getFirstAsync<{ source: string }>('SELECT source FROM catalog_parts WHERE part_id = ?', id);
      if (!existing) {
        await upsertPartOn(tx, {
          partId: id, name: id, categoryId: null, imageUrl: null, bricklinkIds: [], legoIds: [], printOf: null,
          yearFrom: null, yearTo: null, source: 'brickognize', resolution: 'not_found',
        }, nowIso);
      } else if (existing.source === 'brickognize') {
        await tx.runAsync("UPDATE catalog_parts SET resolution = 'not_found', fetched_at = ? WHERE part_id = ?", nowIso, id);
      }
    }
  });
}

/** A pending provisional part resolved: the provisional row `oldId` is replaced by `part` (same or other id) and
 *  the BrickLink map points to it. */
export function replaceProvisional(oldId: PartId, part: CatalogPart, nowIso: string): Promise<void> {
  return withWrite(async (tx) => {
    if (part.partId !== oldId) {
      await tx.runAsync("DELETE FROM catalog_parts WHERE part_id = ? AND source = 'brickognize'", oldId);
    }
    await upsertPartOn(tx, part, nowIso);
    await upsertBlMapOn(tx, oldId, part.partId, nowIso);
  });
}

// ---------------------------------------------------------------- part colours
export async function getPartColor(partId: PartId, colorId: ColorId): Promise<StoredPartColor | null> {
  const r = await db().getFirstAsync<PartColorRowDb>(
    'SELECT * FROM catalog_part_colors WHERE part_id = ? AND color_id = ?', partId, colorId);
  return r ? toPartColor(r) : null;
}

export function savePartColors(rows: readonly PartColorInfo[], nowIso: string): Promise<void> {
  if (rows.length === 0) return Promise.resolve();
  return withWrite(async (tx) => {
    for (const r of rows) {
      await tx.runAsync(
        `INSERT INTO catalog_part_colors (part_id, color_id, found, element_ids, image_url, num_sets, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(part_id, color_id) DO UPDATE SET found = excluded.found, element_ids = excluded.element_ids,
           image_url = excluded.image_url, num_sets = excluded.num_sets, fetched_at = excluded.fetched_at`,
        r.partId, r.colorId, r.found ? 1 : 0, JSON.stringify(r.elementIds), r.imageUrl, r.numSets, nowIso,
      );
    }
  });
}

/** Inventory (part, colour) pairs of live lists with quantity > 0, part among `partIds` and resolved, that have no
 *  catalog_part_colors row; most recently updated first. */
export async function missingPartColors(partIds: readonly PartId[]): Promise<{ partId: PartId; colorId: ColorId }[]> {
  const ids = [...new Set(partIds)];
  if (ids.length === 0) return [];
  const rows = await selectIn<{ part_id: string; color_id: number; updated: string }>((ph) =>
    `SELECT i.part_id, i.color_id, MAX(i.updated_at) AS updated
       FROM items i
       JOIN lists l ON l.id = i.list_id AND l.deleted = 0
       JOIN catalog_parts p ON p.part_id = i.part_id AND p.source = 'rebrickable'
       LEFT JOIN catalog_part_colors pc ON pc.part_id = i.part_id AND pc.color_id = i.color_id
      WHERE i.quantity > 0 AND pc.part_id IS NULL AND i.part_id IN (${ph})
      GROUP BY i.part_id, i.color_id`, ids);
  return rows
    .sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0))
    .map((r) => ({ partId: r.part_id, colorId: r.color_id }));
}
