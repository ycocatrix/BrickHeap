// SQLite side of sync (WP8). Every function takes the `tx` of a withWrite callback opened by services/sync.ts
// (or, for the read-only helpers, db() for a read outside the gate): read + apply + write happen in ONE callback.
// No function here opens withWrite itself.
import type { SQLiteDatabase } from 'expo-sqlite';
import type { ListId, PartId } from '@/domain/types';
import type { ApplyPlan, LocalItemRow, LocalListRow, LocalState } from '@/domain/sync/sync';

interface ListDbRow { id: string; name: string; created_at: string; deleted: number; dirty: number }
interface ItemDbRow { list_id: string; part_id: string; color_id: number; quantity: number; base_quantity: number; held: number }

/** Items whose part is a 'pending' provisional part (D7) are `held`: never pushed. */
const ITEMS_SQL = `
SELECT i.list_id, i.part_id, i.color_id, i.quantity, i.base_quantity,
       CASE WHEN p.part_id IS NULL THEN 0 ELSE 1 END AS held
FROM items i
LEFT JOIN catalog_parts p ON p.part_id = i.part_id AND p.source = 'brickognize' AND p.resolution = 'pending'`;

export async function readLocalState(conn: SQLiteDatabase): Promise<LocalState> {
  const lists = await conn.getAllAsync<ListDbRow>('SELECT id, name, created_at, deleted, dirty FROM lists');
  const items = await conn.getAllAsync<ItemDbRow>(ITEMS_SQL);
  return {
    lists: lists.map((l): LocalListRow => ({ id: l.id, name: l.name, created_at: l.created_at,
      deleted: l.deleted ? 1 : 0, dirty: l.dirty ? 1 : 0 })),
    items: items.map((i): LocalItemRow => ({ list_id: i.list_id, part_id: i.part_id, color_id: i.color_id,
      quantity: i.quantity, base_quantity: i.base_quantity, held: i.held === 1 })),
  };
}

/** Same definition as the pure pendingCount(), in one query (called on every 'mutation'). */
export async function readPendingCounts(conn: SQLiteDatabase): Promise<{ pending: number; awaitingCatalog: number }> {
  const row = await conn.getFirstAsync<{ dirty_lists: number; items: number; held: number }>(`
SELECT
  (SELECT COUNT(*) FROM lists WHERE dirty = 1) AS dirty_lists,
  (SELECT COUNT(*) FROM items i JOIN lists l ON l.id = i.list_id AND l.deleted = 0
     WHERE i.quantity <> i.base_quantity) AS items,
  (SELECT COUNT(*) FROM items i JOIN lists l ON l.id = i.list_id AND l.deleted = 0
     JOIN catalog_parts p ON p.part_id = i.part_id AND p.source = 'brickognize' AND p.resolution = 'pending'
     WHERE i.quantity <> i.base_quantity) AS held`);
  return { pending: (row?.dirty_lists ?? 0) + (row?.items ?? 0), awaitingCatalog: row?.held ?? 0 };
}

/** Distinct part ids of held items (to trigger catalog.hydrateParts). */
export function heldPartIds(local: LocalState): PartId[] {
  return [...new Set(local.items.filter((i) => i.held && i.quantity !== i.base_quantity).map((i) => i.part_id))];
}

async function runMany(tx: SQLiteDatabase, sql: string, rows: readonly (string | number)[][]): Promise<void> {
  if (rows.length === 0) return;
  const stmt = await tx.prepareAsync(sql);
  try {
    for (const params of rows) await stmt.executeAsync(params);
  } finally {
    await stmt.finalizeAsync();
  }
}

const UPSERT_LIST = `INSERT INTO lists (id, name, created_at, deleted, dirty) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET name = excluded.name, created_at = excluded.created_at, deleted = excluded.deleted,
  dirty = excluded.dirty`;
/** updated_at (display ordering only) moves when the quantity changes. */
const UPSERT_ITEM = `INSERT INTO items (list_id, part_id, color_id, quantity, base_quantity, updated_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(list_id, part_id, color_id) DO UPDATE SET quantity = excluded.quantity,
  base_quantity = excluded.base_quantity,
  updated_at = CASE WHEN items.quantity <> excluded.quantity THEN excluded.updated_at ELSE items.updated_at END`;

/** Writes an ApplyPlan (lists/items only; meta is written by the caller on the same tx). */
export async function writePlan(tx: SQLiteDatabase, plan: ApplyPlan, nowIso: string): Promise<void> {
  await runMany(tx, 'DELETE FROM items WHERE list_id = ?', plan.deleteLists.map((id) => [id]));
  await runMany(tx, 'DELETE FROM lists WHERE id = ?', plan.deleteLists.map((id) => [id]));
  await runMany(tx, UPSERT_LIST, plan.upsertLists.map((l) => [l.id, l.name, l.created_at, l.deleted, l.dirty]));
  await runMany(tx, 'DELETE FROM items WHERE list_id = ? AND part_id = ? AND color_id = ?',
    plan.deleteItems.map((r) => [r.listId, r.partId, r.colorId]));
  await runMany(tx, UPSERT_ITEM, plan.upsertItems.map((i) =>
    [i.list_id, i.part_id, i.color_id, i.quantity, i.base_quantity, nowIso]));
}

/** First sync, « Fusionner » (RG_11): local lists mapped to remote ids are dropped and their items move to the
 *  remote list id (collisions already summed by remapGuestItems); every item is rewritten with base_quantity 0;
 *  guest tombstones are removed and the remaining live lists are dirty (they are new for the account). */
export async function applyGuestRemap(tx: SQLiteDatabase, listIdMap: Readonly<Record<ListId, ListId>>,
  remappedItems: readonly LocalItemRow[], nowIso: string): Promise<void> {
  await tx.runAsync('DELETE FROM items');
  await tx.runAsync('DELETE FROM lists WHERE deleted = 1');
  await runMany(tx, 'DELETE FROM lists WHERE id = ?',
    Object.entries(listIdMap).filter(([from, to]) => from !== to).map(([from]) => [from]));
  await tx.runAsync('UPDATE lists SET dirty = 1');
  await runMany(tx, UPSERT_ITEM, remappedItems.map((i) => [i.list_id, i.part_id, i.color_id, i.quantity, 0, nowIso]));
}

/** « Garder uniquement mon compte » / wipe: removes every list and item (catalogue cache and device id kept). */
export async function deleteAllUserRows(tx: SQLiteDatabase): Promise<void> {
  await tx.runAsync('DELETE FROM items');
  await tx.runAsync('DELETE FROM lists');
}

/** keepLocalAsGuest (RG_12): detaches local rows from the account. */
export async function detachAsGuest(tx: SQLiteDatabase): Promise<void> {
  await tx.runAsync('UPDATE items SET base_quantity = 0');
  await tx.runAsync('DELETE FROM items WHERE quantity = 0');
  await tx.runAsync('DELETE FROM items WHERE list_id IN (SELECT id FROM lists WHERE deleted = 1)');
  await tx.runAsync('DELETE FROM lists WHERE deleted = 1');
  await tx.runAsync('UPDATE lists SET dirty = 1');
}
