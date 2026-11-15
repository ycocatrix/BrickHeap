// src/data/inventoryRepo.ts — the only writer of user changes to `lists` / `items` (WP6, §4.8).
// Every mutation = ONE withWrite callback: read the affected rows on `tx` → pure function (mergeDeltas /
// validateListName) → write the result on `tx`; then notify(…, 'mutation') once the transaction committed.
import type { SQLiteDatabase } from 'expo-sqlite';
import { randomUUID } from 'expo-crypto';
import type {
  AppliedDeltas, CatalogPart, InventoryRow, ItemDelta, ItemRef, List, ListId, ListSummary, Palette, PartId, Result,
} from '@/domain/types';
import { err, ok } from '@/domain/result';
import { mergeDeltas, validateListName, type StoredItem } from '@/domain/inventory/inventory';
import { categoryLabel } from '@/domain/catalog/partInfo';
import { inventory as t } from '@/i18n/fr/inventory';
import { getPalette } from '@/services/catalog';
import { db, withWrite } from './db';
import { notify } from './dbEvents';
import { getMeta, setMeta } from './meta';

export const DEFAULT_LIST_NAME = 'Mon inventaire';

interface ListDbRow { id: string; name: string; created_at: string }
interface ItemDbRow {
  list_id: string; part_id: string; color_id: number; quantity: number; base_quantity: number; updated_at: string;
}
interface JoinedDbRow {
  list_id: string; part_id: string; color_id: number; quantity: number; updated_at: string; list_name: string;
  p_id: string | null; p_name: string | null; p_category_id: number | null; p_image_url: string | null;
  p_bricklink_ids: string | null; p_lego_ids: string | null; p_print_of: string | null; p_year_from: number | null;
  p_year_to: number | null; p_source: string | null; p_resolution: string | null; pc_image_url: string | null;
}

const nowIso = (): string => new Date().toISOString();
const toList = (r: ListDbRow): List => ({ id: r.id, name: r.name, createdAt: r.created_at });

function jsonStrings(v: string | null): string[] {
  if (!v) return [];
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function liveLists(conn: SQLiteDatabase): Promise<ListDbRow[]> {
  return conn.getAllAsync<ListDbRow>(
    'SELECT id, name, created_at FROM lists WHERE deleted = 0 ORDER BY created_at, id');
}

async function insertList(tx: SQLiteDatabase, name: string): Promise<List> {
  const list: List = { id: randomUUID(), name, createdAt: nowIso() };
  await tx.runAsync('INSERT INTO lists (id, name, created_at, deleted, dirty) VALUES (?, ?, ?, 0, 1)',
    list.id, list.name, list.createdAt);
  return list;
}

/** Returns a live list, creating DEFAULT_LIST_NAME (dirty = 1) when none exists. */
export async function ensureDefaultList(): Promise<List> {
  const existing = await db().getFirstAsync<ListDbRow>(
    'SELECT id, name, created_at FROM lists WHERE deleted = 0 ORDER BY created_at, id LIMIT 1');
  if (existing) return toList(existing);
  const { list, created } = await withWrite(async (tx) => {
    const again = await tx.getFirstAsync<ListDbRow>(
      'SELECT id, name, created_at FROM lists WHERE deleted = 0 ORDER BY created_at, id LIMIT 1');
    if (again) return { list: toList(again), created: false };
    return { list: await insertList(tx, DEFAULT_LIST_NAME), created: true };
  });
  if (created) notify('lists', 'mutation');
  return list;
}

/** Live lists by created_at (ensureDefaultList first); counts over items with quantity > 0. */
export async function getLists(): Promise<ListSummary[]> {
  await ensureDefaultList();
  const rows = await db().getAllAsync<ListDbRow & { ref_count: number; piece_count: number }>(
    `SELECT l.id, l.name, l.created_at,
            COUNT(i.part_id) AS ref_count, COALESCE(SUM(i.quantity), 0) AS piece_count
       FROM lists l
       LEFT JOIN items i ON i.list_id = l.id AND i.quantity > 0
      WHERE l.deleted = 0
      GROUP BY l.id
      ORDER BY l.created_at, l.id`);
  return rows.map((r) => ({ ...toList(r), refCount: r.ref_count, pieceCount: r.piece_count }));
}

/** Name trimmed, 1–60 chars, unique (case and accents ignored) among live lists. */
export async function createList(name: string): Promise<Result<List>> {
  const res = await withWrite(async (tx): Promise<Result<List>> => {
    const lists = await liveLists(tx);
    const valid = validateListName(name, lists.map((l) => l.name));
    if (!valid.ok) return valid;
    return ok(await insertList(tx, valid.value));
  });
  if (res.ok) notify('lists', 'mutation');
  return res;
}

export async function renameList(id: ListId, name: string): Promise<Result<void>> {
  const res = await withWrite(async (tx): Promise<Result<void>> => {
    const lists = await liveLists(tx);
    const target = lists.find((l) => l.id === id);
    if (!target) return err('not_found', t.errors.listNotFound);
    const valid = validateListName(name, lists.filter((l) => l.id !== id).map((l) => l.name));
    if (!valid.ok) return valid;
    if (valid.value === target.name) return ok(undefined);
    await tx.runAsync('UPDATE lists SET name = ?, dirty = 1 WHERE id = ?', valid.value, id);
    return ok(undefined);
  });
  if (res.ok) notify('lists', 'inventory', 'mutation');
  return res;
}

/** Refused for the last live list. Removes the list's items; the row becomes a dirty tombstone, hard-deleted only
 *  when meta.owner_uid is null (guest: never pushed). */
export async function deleteList(id: ListId): Promise<Result<void>> {
  const res = await withWrite(async (tx): Promise<Result<void>> => {
    const lists = await liveLists(tx);
    if (!lists.some((l) => l.id === id)) return err('not_found', t.errors.listNotFound);
    if (lists.length <= 1) return err('invalid', t.errors.lastList);
    await tx.runAsync('DELETE FROM items WHERE list_id = ?', id);
    const owner = await getMeta('owner_uid', tx);
    if (owner === null) await tx.runAsync('DELETE FROM lists WHERE id = ?', id);
    else await tx.runAsync('UPDATE lists SET deleted = 1, dirty = 1 WHERE id = ?', id);
    return ok(undefined);
  });
  if (res.ok) notify('lists', 'inventory', 'mutation');
  return res;
}

async function safePalette(): Promise<Palette | null> {
  try {
    return await getPalette();
  } catch {
    return null;
  }
}

function toPart(r: JoinedDbRow): CatalogPart | null {
  if (r.p_id === null || r.p_name === null) return null;
  const source = r.p_source === 'brickognize' ? 'brickognize' : 'rebrickable';
  const resolution = r.p_resolution === 'pending' || r.p_resolution === 'not_found' ? r.p_resolution : 'resolved';
  return {
    partId: r.p_id,
    name: r.p_name,
    categoryId: r.p_category_id,
    imageUrl: r.p_image_url,
    bricklinkIds: jsonStrings(r.p_bricklink_ids),
    legoIds: jsonStrings(r.p_lego_ids),
    printOf: r.p_print_of,
    yearFrom: r.p_year_from,
    yearTo: r.p_year_to,
    source,
    resolution,
  };
}

/** Rows with quantity > 0 of live lists, most recently updated first, joined with catalog_parts and
 *  catalog_part_colors; colour and category names come from getPalette() in JS. */
export async function getItems(listId: ListId | null): Promise<InventoryRow[]> {
  const sql = `SELECT i.list_id, i.part_id, i.color_id, i.quantity, i.updated_at, l.name AS list_name,
            p.part_id AS p_id, p.name AS p_name, p.category_id AS p_category_id, p.image_url AS p_image_url,
            p.bricklink_ids AS p_bricklink_ids, p.lego_ids AS p_lego_ids, p.print_of AS p_print_of,
            p.year_from AS p_year_from, p.year_to AS p_year_to, p.source AS p_source, p.resolution AS p_resolution,
            pc.image_url AS pc_image_url
       FROM items i
       JOIN lists l ON l.id = i.list_id AND l.deleted = 0
       LEFT JOIN catalog_parts p ON p.part_id = i.part_id
       LEFT JOIN catalog_part_colors pc ON pc.part_id = i.part_id AND pc.color_id = i.color_id
      WHERE i.quantity > 0${listId === null ? '' : ' AND i.list_id = ?'}
      ORDER BY i.updated_at DESC, i.part_id, i.color_id`;
  const rows = listId === null
    ? await db().getAllAsync<JoinedDbRow>(sql)
    : await db().getAllAsync<JoinedDbRow>(sql, listId);
  const palette = await safePalette();
  return rows.map((r) => {
    const part = toPart(r);
    const color = palette?.byId.get(r.color_id) ?? null;
    const categoryId = part?.categoryId ?? null;
    const paletteCategory = categoryId === null ? null : palette?.categoryName.get(categoryId) ?? null;
    return {
      listId: r.list_id,
      partId: r.part_id,
      colorId: r.color_id,
      quantity: r.quantity,
      updatedAt: r.updated_at,
      listName: r.list_name,
      part,
      color,
      imageUrl: r.pc_image_url ?? part?.imageUrl ?? null,
      coloredImage: r.pc_image_url !== null,
      categoryName: categoryId === null ? null : categoryLabel(categoryId, paletteCategory),
    };
  });
}

/** Core of every quantity change; runs on the `tx` of the caller's withWrite callback. Deltas on lists that are
 *  not live are ignored (no orphan rows). */
async function applyDeltasTx(tx: SQLiteDatabase, deltas: readonly ItemDelta[]): Promise<AppliedDeltas> {
  if (deltas.length === 0) return { applied: [], inverse: [] };
  const live = new Set((await liveLists(tx)).map((l) => l.id));
  const usable = deltas.filter((d) => live.has(d.listId));
  const seen = new Set<string>();
  const current: StoredItem[] = [];
  for (const d of usable) {
    const k = `${d.listId}\u0000${d.partId}\u0000${d.colorId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const row = await tx.getFirstAsync<ItemDbRow>(
      `SELECT list_id, part_id, color_id, quantity, base_quantity, updated_at
         FROM items WHERE list_id = ? AND part_id = ? AND color_id = ?`, d.listId, d.partId, d.colorId);
    if (row) {
      current.push({
        listId: row.list_id, partId: row.part_id, colorId: row.color_id, quantity: row.quantity,
        base_quantity: row.base_quantity, updatedAt: row.updated_at,
      });
    }
  }
  const now = nowIso();
  const result = mergeDeltas(current, usable, now);
  const changed = new Set(result.applied.applied.map((d) => `${d.listId}\u0000${d.partId}\u0000${d.colorId}`));
  for (const it of result.items) {
    if (!changed.has(`${it.listId}\u0000${it.partId}\u0000${it.colorId}`)) continue;
    await tx.runAsync(
      `INSERT INTO items (list_id, part_id, color_id, quantity, base_quantity, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (list_id, part_id, color_id) DO UPDATE SET quantity = excluded.quantity,
         updated_at = excluded.updated_at`,
      it.listId, it.partId, it.colorId, it.quantity, it.base_quantity, it.updatedAt);
  }
  for (const r of result.deleted) {
    await tx.runAsync('DELETE FROM items WHERE list_id = ? AND part_id = ? AND color_id = ?',
      r.listId, r.partId, r.colorId);
  }
  return result.applied;
}

function notifyIfApplied(res: AppliedDeltas): AppliedDeltas {
  if (res.applied.length > 0) notify('inventory', 'lists', 'mutation');
  return res;
}

/** RG_08: quantity = clamp(quantity + delta, 0, 100000), row created when missing; deltas on one key summed;
 *  rows ending at quantity 0 with base_quantity 0 deleted (RG_10). `inverse` undoes exactly what was applied. */
export async function applyDeltas(deltas: readonly ItemDelta[]): Promise<AppliedDeltas> {
  if (deltas.length === 0) return { applied: [], inverse: [] };
  return notifyIfApplied(await withWrite((tx) => applyDeltasTx(tx, deltas)));
}

/** EX_16; 0 hides (RG_10). */
export async function setQuantity(ref: ItemRef, quantity: number): Promise<AppliedDeltas> {
  const target = Math.max(0, Math.trunc(quantity));
  return notifyIfApplied(await withWrite(async (tx) => {
    const row = await tx.getFirstAsync<{ quantity: number }>(
      'SELECT quantity FROM items WHERE list_id = ? AND part_id = ? AND color_id = ?',
      ref.listId, ref.partId, ref.colorId);
    const delta = target - (row?.quantity ?? 0);
    if (delta === 0) return { applied: [], inverse: [] };
    return applyDeltasTx(tx, [{ listId: ref.listId, partId: ref.partId, colorId: ref.colorId, delta }]);
  }));
}

/** EX_16: −q on the source key, +q on the target key in one transaction (q = whole quantity by default). */
export async function moveItem(ref: ItemRef, toListId: ListId, quantity?: number): Promise<AppliedDeltas> {
  if (toListId === ref.listId) return { applied: [], inverse: [] };
  return notifyIfApplied(await withWrite(async (tx) => {
    const target = await tx.getFirstAsync<{ id: string }>('SELECT id FROM lists WHERE id = ? AND deleted = 0', toListId);
    if (!target) return { applied: [], inverse: [] };
    const row = await tx.getFirstAsync<{ quantity: number }>(
      'SELECT quantity FROM items WHERE list_id = ? AND part_id = ? AND color_id = ?',
      ref.listId, ref.partId, ref.colorId);
    const available = row?.quantity ?? 0;
    const q = Math.min(available, quantity === undefined ? available : Math.max(0, Math.trunc(quantity)));
    if (q <= 0) return { applied: [], inverse: [] };
    return applyDeltasTx(tx, [
      { listId: ref.listId, partId: ref.partId, colorId: ref.colorId, delta: -q },
      { listId: toListId, partId: ref.partId, colorId: ref.colorId, delta: q },
    ]);
  }));
}

/** D7 reconciliation (called by catalog.hydrateParts): moves the quantity of every item of oldPartId with
 *  base_quantity = 0 onto newPartId (same list and colour, summed through mergeDeltas, base_quantity of the target
 *  unchanged) and deletes the old rows. Rows with base_quantity > 0 are left untouched (defensive). */
export async function renamePart(oldPartId: PartId, newPartId: PartId): Promise<void> {
  if (oldPartId === newPartId) return;
  const res = await withWrite(async (tx) => {
    const rows = await tx.getAllAsync<{ list_id: string; color_id: number; quantity: number }>(
      'SELECT list_id, color_id, quantity FROM items WHERE part_id = ? AND base_quantity = 0', oldPartId);
    const deltas: ItemDelta[] = [];
    for (const r of rows) {
      if (r.quantity > 0) {
        deltas.push({ listId: r.list_id, partId: oldPartId, colorId: r.color_id, delta: -r.quantity });
        deltas.push({ listId: r.list_id, partId: newPartId, colorId: r.color_id, delta: r.quantity });
      }
    }
    const applied = await applyDeltasTx(tx, deltas);
    // Hidden rows (quantity 0, base 0) cannot exist, but never leave an old-id row behind.
    await tx.runAsync('DELETE FROM items WHERE part_id = ? AND base_quantity = 0 AND quantity = 0', oldPartId);
    return applied;
  });
  notifyIfApplied(res);
}

/** meta.last_list_id when it is still a live list, else ensureDefaultList().id (EX_07). */
export async function getLastListId(): Promise<ListId> {
  const last = await getMeta('last_list_id');
  if (last) {
    const row = await db().getFirstAsync<{ id: string }>('SELECT id FROM lists WHERE id = ? AND deleted = 0', last);
    if (row) return row.id;
  }
  return (await ensureDefaultList()).id;
}

export async function setLastListId(id: ListId): Promise<void> {
  await setMeta('last_list_id', id);
}
