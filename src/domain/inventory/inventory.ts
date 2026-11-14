// Pure inventory rules (WP6, §4.8): list names, RG_08 / RG_10 merge, search / filters / grouping, totals.
import type {
  AppliedDeltas, InventoryFilter, InventoryItem, InventoryRow, InventorySection, ItemDelta, ItemRef, Result,
} from '../types';
import { err, ok } from '../result';
import { itemKey } from '../keys';
import { categoryLabel, partLabel } from '../catalog/partInfo';
import { colorLabel } from '../../i18n/fr/colors';
import { tpl } from '../../i18n/format';
import { inventory as t } from '../../i18n/fr/inventory';

export const LIST_NAME_MAX = 60;
/** RG_08: a quantity never exceeds this value (mirrors BATCH_LIMITS.deltaMax on the server side). */
export const QUANTITY_MAX = 100000;

export type StoredItem = InventoryItem & { base_quantity: number };

const ACCENTS: Readonly<Record<string, string>> = {
  à: 'a', á: 'a', â: 'a', ã: 'a', ä: 'a', å: 'a', ç: 'c', è: 'e', é: 'e', ê: 'e', ë: 'e', ì: 'i', í: 'i', î: 'i',
  ï: 'i', ñ: 'n', ò: 'o', ó: 'o', ô: 'o', õ: 'o', ö: 'o', ù: 'u', ú: 'u', û: 'u', ü: 'u', ý: 'y', ÿ: 'y',
  œ: 'oe', æ: 'ae', '×': 'x',
};

/** Case- and diacritics-insensitive form used for search, name uniqueness and sorting. Does not rely on
 *  String.prototype.normalize alone (Hermes builds without Intl lack it): a small Latin map is applied too. */
export function fold(s: string): string {
  let out = s.toLowerCase();
  try {
    if (typeof out.normalize === 'function') out = out.normalize('NFD').replace(/[̀-ͯ]/g, '');
  } catch {
    // keep the lower-cased text; the map below still strips common accents
  }
  return out.replace(/[\u0080-￿]/g, (c) => ACCENTS[c] ?? c);
}

function compareText(a: string, b: string): number {
  const fa = fold(a);
  const fb = fold(b);
  if (fa < fb) return -1;
  if (fa > fb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Display name of a row: French label of the catalogue name, else the part id (not hydrated yet). */
export function rowName(row: Pick<InventoryRow, 'part' | 'partId'>): string {
  return row.part && row.part.name ? partLabel(row.part.name) : row.partId;
}

/** Colour label of a row: French / Rebrickable name, else « Couleur {id} » while the palette is unknown. */
export function rowColorName(row: Pick<InventoryRow, 'color' | 'colorId'>): string {
  return row.color ? colorLabel(row.color) : tpl(t.groups.unknownColor, { id: row.colorId });
}

/** Returns the trimmed name. 1–60 characters, unique among `existing` ignoring case and accents. */
export function validateListName(name: string, existing: readonly string[]): Result<string> {
  const trimmed = name.trim();
  if (trimmed.length === 0) return err('invalid', t.errors.nameEmpty);
  if (trimmed.length > LIST_NAME_MAX) return err('invalid', tpl(t.errors.nameTooLong, { max: LIST_NAME_MAX }));
  const key = fold(trimmed);
  if (existing.some((e) => fold(e.trim()) === key)) return err('invalid', t.errors.nameTaken);
  return ok(trimmed);
}

function refKey(r: ItemRef): string {
  return `${r.listId}\u0000${itemKey(r.partId, r.colorId)}`;
}

function clampQuantity(q: number): number {
  return Math.min(QUANTITY_MAX, Math.max(0, q));
}

/** RG_08 / RG_10 on plain data; inventoryRepo runs exactly this inside withWrite.
 *  - Deltas on the same key are summed first; a zero sum is a no-op.
 *  - quantity = clamp(quantity + delta, 0, 100000); a missing row starts at quantity 0, base_quantity 0.
 *  - base_quantity is carried through unchanged.
 *  - `items`: every input row plus the created ones, after the merge, minus `deleted`.
 *  - `deleted`: existing rows that end with quantity 0 and base_quantity 0 (a row with base_quantity > 0 stays as a
 *    hidden tombstone so sync can push the negative delta).
 *  - `applied` holds the deltas actually applied (after clamping); `inverse` the same negated. */
export function mergeDeltas(items: readonly StoredItem[], deltas: readonly ItemDelta[],
  nowIso: string): { items: StoredItem[]; deleted: ItemRef[]; applied: AppliedDeltas } {
  const summed = new Map<string, ItemDelta>();
  for (const d of deltas) {
    const delta = Math.trunc(d.delta);
    if (!Number.isFinite(delta)) continue;
    const k = refKey(d);
    const prev = summed.get(k);
    if (prev) prev.delta += delta;
    else summed.set(k, { listId: d.listId, partId: d.partId, colorId: d.colorId, delta });
  }

  const rows = new Map<string, StoredItem>();
  const existed = new Set<string>();
  for (const it of items) {
    const k = refKey(it);
    rows.set(k, { ...it });
    existed.add(k);
  }

  const applied: ItemDelta[] = [];
  const inverse: ItemDelta[] = [];
  for (const [k, d] of summed) {
    if (d.delta === 0) continue;
    const row = rows.get(k) ?? {
      listId: d.listId, partId: d.partId, colorId: d.colorId, quantity: 0, base_quantity: 0, updatedAt: nowIso,
    };
    const next = clampQuantity(row.quantity + d.delta);
    const actual = next - row.quantity;
    if (actual === 0) continue;
    rows.set(k, { ...row, quantity: next, updatedAt: nowIso });
    applied.push({ listId: d.listId, partId: d.partId, colorId: d.colorId, delta: actual });
    inverse.push({ listId: d.listId, partId: d.partId, colorId: d.colorId, delta: -actual });
  }

  const out: StoredItem[] = [];
  const deleted: ItemRef[] = [];
  for (const [k, row] of rows) {
    if (row.quantity === 0 && row.base_quantity === 0) {
      if (existed.has(k)) deleted.push({ listId: row.listId, partId: row.partId, colorId: row.colorId });
      continue;
    }
    out.push(row);
  }
  return { items: out, deleted, applied: { applied, inverse } };
}

function haystack(row: InventoryRow): string {
  const parts = [row.partId, rowColorName(row)];
  if (row.part?.name) parts.push(row.part.name, partLabel(row.part.name));
  if (row.color?.name) parts.push(row.color.name);
  if (row.categoryName) parts.push(row.categoryName);
  return fold(parts.join(' \u0001 '));
}

function categoryTitle(row: InventoryRow): string {
  return row.categoryName ?? categoryLabel(row.part?.categoryId ?? null, null) ?? t.groups.noCategory;
}

function sortRows(rows: InventoryRow[]): InventoryRow[] {
  return rows.sort((a, b) =>
    compareText(rowName(a), rowName(b))
    || compareText(rowColorName(a), rowColorName(b))
    || compareText(a.listName, b.listName));
}

/** Search (case/diacritics-insensitive, every word must match one of: French label, official name, part id,
 *  colour FR/EN name, category FR name), colour and category filters, then grouping. Sections sorted by title,
 *  rows by name. groupBy 'none' → one section with key 'all' (empty when nothing matches). */
export function filterAndGroup(rows: readonly InventoryRow[], filter: InventoryFilter): InventorySection[] {
  const words = fold(filter.query).split(/\s+/).filter((w) => w.length > 0);
  const colorSet = new Set(filter.colorIds);
  const categorySet = new Set(filter.categoryIds);

  const kept = rows.filter((r) => {
    if (r.quantity <= 0) return false;
    if (filter.listId !== null && r.listId !== filter.listId) return false;
    if (colorSet.size > 0 && !colorSet.has(r.colorId)) return false;
    if (categorySet.size > 0) {
      const cat = r.part?.categoryId;
      if (cat == null || !categorySet.has(cat)) return false;
    }
    if (words.length > 0) {
      const h = haystack(r);
      if (!words.every((w) => h.includes(w))) return false;
    }
    return true;
  });

  if (filter.groupBy === 'none') {
    return kept.length === 0 ? [] : [{ key: 'all', title: t.groups.all, rows: sortRows(kept) }];
  }

  const sections = new Map<string, InventorySection>();
  for (const r of kept) {
    let key: string;
    let title: string;
    switch (filter.groupBy) {
      case 'category':
        key = `cat:${r.part?.categoryId ?? 'none'}`;
        title = categoryTitle(r);
        break;
      case 'color':
        key = `col:${r.colorId}`;
        title = rowColorName(r);
        break;
      case 'list':
      default:
        key = `list:${r.listId}`;
        title = r.listName;
        break;
    }
    const s = sections.get(key);
    if (s) s.rows.push(r);
    else sections.set(key, { key, title, rows: [r] });
  }
  return [...sections.values()]
    .map((s) => ({ ...s, rows: sortRows(s.rows) }))
    .sort((a, b) => compareText(a.title, b.title) || compareText(a.key, b.key));
}

/** refs = rows with quantity > 0; pieces = sum of their quantities. */
export function inventoryTotals(rows: readonly InventoryRow[]): { refs: number; pieces: number } {
  let refs = 0;
  let pieces = 0;
  for (const r of rows) {
    if (r.quantity <= 0) continue;
    refs++;
    pieces += r.quantity;
  }
  return { refs, pieces };
}
