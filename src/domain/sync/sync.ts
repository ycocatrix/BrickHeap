// Pure sync planning (§4.10, D11): batches of quantity deltas, response application, guest merge.
// No React Native import, no I/O: syncRepo / services/sync run these inside one withWrite callback.
import type {
  ColorId, ItemRef, ListId, PartId, SyncBatch, SyncItemDeltaWire, SyncListWire, SyncResponse,
} from '../types';

export interface LocalListRow { id: ListId; name: string; created_at: string; deleted: 0 | 1; dirty: 0 | 1 }
export interface LocalItemRow {
  list_id: ListId; part_id: PartId; color_id: ColorId; quantity: number; base_quantity: number;
  /** The part is a 'pending' provisional part (D7): never pushed. syncRepo computes it by joining catalog_parts
   *  (source 'brickognize' and resolution 'pending'). */
  held: boolean;
}
export interface LocalState { lists: LocalListRow[]; items: LocalItemRow[] }
/** Mirrors the server checks of public.sync so a batch is never deterministically rejected. */
export const BATCH_LIMITS = { items: 2000, lists: 200, nameMax: 60, partIdMax: 40, deltaMax: 100000 } as const;

/** Server-side maximum item quantity (inventory_items_quantity_check). */
const QUANTITY_MAX = 100000;
const FULL_PULL_AFTER_DAYS = 60;
const DAY_MS = 86400000;

const keyOf = (listId: ListId, partId: PartId, colorId: ColorId): string => `${listId}\u0000${partId}\u0000${colorId}`;
const refKey = (r: { list_id: ListId; part_id: PartId; color_id: ColorId }): string =>
  keyOf(r.list_id, r.part_id, r.color_id);
/** Postgres char_length counts code points, not UTF-16 units. */
const codePoints = (s: string): number => Array.from(s).length;
const normName = (s: string): string => s.trim().toLowerCase();
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const byCreated = (a: { created_at: string; id: string }, b: { created_at: string; id: string }): number =>
  a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** A list row the server accepts: name non-blank after trim and ≤ nameMax code points (raw, as stored). */
export function isValidListName(name: string): boolean {
  return name.trim().length > 0 && codePoints(name) <= BATCH_LIMITS.nameMax;
}
export function isValidPartId(partId: string): boolean {
  const n = codePoints(partId);
  return n >= 1 && n <= BATCH_LIMITS.partIdMax;
}

/** lists = dirty rows (≤ BATCH_LIMITS.lists); items = rows with quantity ≠ base_quantity, not held, whose list is
 *  live, as deltas clamped to ±deltaMax (≤ BATCH_LIMITS.items). Rows the server would reject (list name not
 *  1..nameMax after trim, part_id length not 1..partIdMax) are left out and returned in `invalid`. `more` = some
 *  eligible rows did not fit (the service loops).
 *  Items of a dirty list that is not part of this batch (it did not fit, or its name is invalid) are deferred: the
 *  list may not exist on the server yet and the server would silently drop deltas on an unknown list. Items of an
 *  invalid list are reported in `invalid.items`. */
export function buildBatch(local: LocalState, batchId: string):
  { batch: SyncBatch; more: boolean; invalid: { lists: ListId[]; items: ItemRef[] } } {
  const invalidLists: ListId[] = [];
  const invalidItems: ItemRef[] = [];
  let more = false;

  const dirty = local.lists.filter((l) => l.dirty === 1).sort(byCreated);
  const sentLists: SyncListWire[] = [];
  const invalidListIds = new Set<ListId>();
  for (const l of dirty) {
    if (!isValidListName(l.name)) {
      invalidLists.push(l.id);
      invalidListIds.add(l.id);
      continue;
    }
    if (sentLists.length >= BATCH_LIMITS.lists) {
      more = true;
      continue;
    }
    sentLists.push({ id: l.id, name: l.name, created_at: l.created_at, deleted: l.deleted === 1 });
  }
  const sentIds = new Set(sentLists.map((l) => l.id));
  const liveLists = new Map(local.lists.filter((l) => l.deleted === 0).map((l) => [l.id, l]));

  const items: SyncItemDeltaWire[] = [];
  for (const it of local.items) {
    if (it.held || it.quantity === it.base_quantity) continue;
    const list = liveLists.get(it.list_id);
    if (!list) continue;
    const ref: ItemRef = { listId: it.list_id, partId: it.part_id, colorId: it.color_id };
    if (invalidListIds.has(it.list_id)) {
      invalidItems.push(ref);
      continue;
    }
    if (!isValidPartId(it.part_id)) {
      invalidItems.push(ref);
      continue;
    }
    if (list.dirty === 1 && !sentIds.has(list.id)) {
      more = true;
      continue;
    }
    if (items.length >= BATCH_LIMITS.items) {
      more = true;
      continue;
    }
    const delta = clamp(it.quantity - it.base_quantity, -BATCH_LIMITS.deltaMax, BATCH_LIMITS.deltaMax);
    items.push({ list_id: it.list_id, part_id: it.part_id, color_id: it.color_id, delta });
  }
  return { batch: { batchId, lists: sentLists, items }, more, invalid: { lists: invalidLists, items: invalidItems } };
}

export function isEmptyBatch(batch: SyncBatch): boolean {
  return batch.lists.length === 0 && batch.items.length === 0;
}

/** pending = dirty lists + items with quantity ≠ base_quantity (held included); awaitingCatalog = held ones.
 *  Items of a list that is not live are not counted (they can never be pushed). */
export function pendingCount(local: LocalState): { pending: number; awaitingCatalog: number } {
  const live = new Set(local.lists.filter((l) => l.deleted === 0).map((l) => l.id));
  let pending = local.lists.filter((l) => l.dirty === 1).length;
  let awaitingCatalog = 0;
  for (const it of local.items) {
    if (it.quantity === it.base_quantity || !live.has(it.list_id)) continue;
    pending++;
    if (it.held) awaitingCatalog++;
  }
  return { pending, awaitingCatalog };
}

export interface ApplyPlan {
  upsertItems: LocalItemRow[];        // full rows to write (held is not stored)
  deleteItems: ItemRef[];
  upsertLists: LocalListRow[];
  deleteLists: ListId[];              // remove the list and its items locally
  since: string;                      // response.server_time, verbatim
}

interface WorkItem { list_id: ListId; part_id: PartId; color_id: ColorId; quantity: number; base_quantity: number;
  held: boolean; existed: boolean }

/** `local` = state read INSIDE the same withWrite callback that writes the plan (may contain edits made during
 *  the request). Steps 0–8 of §4.10:
 *  0. A sent or returned item absent from local.items is treated as { quantity 0, base_quantity 0 }.
 *  1. Acknowledge: for each sent item delta, base_quantity += delta.
 *  2. For each returned item with server quantity S: localDelta = quantity − base_quantity;
 *     base_quantity = S; quantity = max(0, S + localDelta) (also capped at 100000, the server maximum).
 *  3. Items (sent or returned) whose list is a local tombstone, ends in deleteLists, or is unknown locally after
 *     this plan are never upserted.
 *  4. Returned lists: deleted → deleteLists; live and absent locally → inserted with dirty = 0; live and present:
 *     local dirty and (not sent, or edited after the batch was built) → keep local values, dirty = 1; else
 *     name/created_at from the server, dirty = 0.
 *  5. Sent lists not edited meanwhile → dirty = 0; sent tombstones → deleteLists.
 *  6. Items with quantity = 0 and base_quantity = 0 → deleteItems.
 *  7. fullPull: local items with quantity = base_quantity > 0 that are absent from the response → deleteItems.
 *  8. dedupeListNames over the resulting live lists; renamed rows go to upsertLists. */
export function applyResponse(local: LocalState, sent: SyncBatch, response: SyncResponse, fullPull: boolean): ApplyPlan {
  // ---- lists (steps 4, 5) ----
  const localLists = new Map(local.lists.map((l) => [l.id, l]));
  const finalLists = new Map<ListId, LocalListRow>(local.lists.map((l) => [l.id, { ...l }]));
  const deleteLists = new Set<ListId>();
  const sentLists = new Map(sent.lists.map((l) => [l.id, l]));
  const editedSince = (l: LocalListRow, s: SyncListWire): boolean => l.name !== s.name || (l.deleted === 1) !== s.deleted;

  for (const s of sent.lists) {
    const l = localLists.get(s.id);
    if (!l || editedSince(l, s)) continue;
    if (s.deleted) deleteLists.add(s.id);
    else finalLists.set(s.id, { ...l, dirty: 0 });
  }
  for (const r of response.lists) {
    if (r.deleted) {
      deleteLists.add(r.id);
      continue;
    }
    const l = localLists.get(r.id);
    if (!l) {
      finalLists.set(r.id, { id: r.id, name: r.name, created_at: r.created_at, deleted: 0, dirty: 0 });
      continue;
    }
    const s = sentLists.get(r.id);
    if (l.dirty === 1 && (!s || editedSince(l, s))) {
      finalLists.set(r.id, { ...l, dirty: 1 });
    } else {
      finalLists.set(r.id, { id: l.id, name: r.name, created_at: r.created_at, deleted: 0, dirty: 0 });
    }
  }
  for (const id of deleteLists) finalLists.delete(id);

  // ---- items (steps 0, 1, 2) ----
  const work = new Map<string, WorkItem>(local.items.map((it) => [refKey(it), { ...it, existed: true }]));
  const touched = new Set<string>();
  const getOrZero = (r: { list_id: ListId; part_id: PartId; color_id: ColorId }): WorkItem => {
    const k = refKey(r);
    let w = work.get(k);
    if (!w) {
      w = { list_id: r.list_id, part_id: r.part_id, color_id: r.color_id, quantity: 0, base_quantity: 0, held: false,
        existed: false };
      work.set(k, w);
    }
    touched.add(k);
    return w;
  };
  for (const d of sent.items) {
    const w = getOrZero(d);
    w.base_quantity += d.delta;
  }
  const returned = new Set<string>();
  for (const r of response.items) {
    const w = getOrZero(r);
    returned.add(refKey(r));
    const localDelta = w.quantity - w.base_quantity;
    w.base_quantity = r.quantity;
    w.quantity = clamp(r.quantity + localDelta, 0, QUANTITY_MAX);
  }

  // ---- items (steps 3, 6, 7) ----
  const liveFinal = (listId: ListId): boolean => {
    const l = finalLists.get(listId);
    return !!l && l.deleted === 0;
  };
  const upsertItems: LocalItemRow[] = [];
  const deleteItems: ItemRef[] = [];
  const toRef = (w: WorkItem): ItemRef => ({ listId: w.list_id, partId: w.part_id, colorId: w.color_id });
  for (const [k, w] of work) {
    if (deleteLists.has(w.list_id)) continue;              // removed with its list by writePlan
    const stale = fullPull && w.existed && !returned.has(k) && w.quantity === w.base_quantity && w.quantity > 0;
    if (touched.has(k)) {
      if (!liveFinal(w.list_id)) continue;                  // step 3
      if ((w.quantity === 0 && w.base_quantity === 0) || stale) {
        if (w.existed) deleteItems.push(toRef(w));          // steps 6, 7
        continue;
      }
      upsertItems.push({ list_id: w.list_id, part_id: w.part_id, color_id: w.color_id, quantity: w.quantity,
        base_quantity: w.base_quantity, held: w.held });
    } else if (stale) {
      deleteItems.push(toRef(w));                           // step 7
    }
  }

  // ---- step 8 ----
  for (const renamed of dedupeListNames([...finalLists.values()])) finalLists.set(renamed.id, renamed);
  const upsertLists: LocalListRow[] = [];
  for (const l of finalLists.values()) {
    const before = localLists.get(l.id);
    if (!before || before.name !== l.name || before.created_at !== l.created_at || before.deleted !== l.deleted
      || before.dirty !== l.dirty) {
      upsertLists.push(l);
    }
  }
  const deleteListIds = [...deleteLists].filter(
    (id) => localLists.has(id) || local.items.some((it) => it.list_id === id),
  );
  return { upsertItems, deleteItems, upsertLists, deleteLists: deleteListIds, since: response.server_time };
}

function withSuffix(name: string, n: number): string {
  const suffix = ` (${n})`;
  const room = BATCH_LIMITS.nameMax - codePoints(suffix);
  const chars = Array.from(name.trim());
  return (chars.length > room ? chars.slice(0, room).join('').trimEnd() : chars.join('')) + suffix;
}

/** Deterministic, so every device computes the same result: among live lists whose trimmed, case-insensitive
 *  names collide, the one with the smallest (created_at, id) keeps the name; the others become « {name} (2) »,
 *  « (3) »… (truncated to 60 characters, skipping suffixes already taken) with dirty = 1. Returns only the
 *  changed rows. */
export function dedupeListNames(lists: readonly LocalListRow[]): LocalListRow[] {
  const live = lists.filter((l) => l.deleted === 0);
  const groups = new Map<string, LocalListRow[]>();
  for (const l of live) {
    const k = normName(l.name);
    const g = groups.get(k);
    if (g) g.push(l);
    else groups.set(k, [l]);
  }
  const used = new Set(groups.keys());
  const changed: LocalListRow[] = [];
  for (const k of [...groups.keys()].sort()) {
    const g = groups.get(k)!;
    if (g.length < 2) continue;
    g.sort(byCreated);
    for (const l of g.slice(1)) {
      let n = 2;
      let candidate = withSuffix(l.name, n);
      while (used.has(normName(candidate))) candidate = withSuffix(l.name, ++n);
      used.add(normName(candidate));
      changed.push({ ...l, name: candidate, dirty: 1 });
    }
  }
  return changed;
}

/** Parses a Postgres/ISO timestamptz text ('2026-11-14T21:03:11.120534+00:00', '… 21:03:11+00', '…Z') to epoch
 *  ms without going through Date.parse (fractional precision support is engine dependent). NaN when unparsable. */
export function parseTimestamp(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(s.trim());
  if (!m) return NaN;
  const ms = m[7] ? Number((m[7] + '000').slice(0, 3)) : 0;
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms);
  const tz = m[8];
  if (tz && tz.toUpperCase() !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1;
    const digits = tz.slice(1).replace(':', '');
    const offMin = Number(digits.slice(0, 2)) * 60 + (digits.length > 2 ? Number(digits.slice(2, 4)) : 0);
    t -= sign * offMin * 60000;
  }
  return t;
}

/** true when `since` is null or older than 60 days (server tombstones are purged after 90). */
export function needsFullPull(since: string | null, now: Date): boolean {
  if (!since) return true;
  const t = parseTimestamp(since);
  if (Number.isNaN(t)) return true;
  return now.getTime() - t > FULL_PULL_AFTER_DAYS * DAY_MS;
}

/** First sync of a device for an account (RG_11): maps local live lists to remote lists by trimmed,
 *  case-insensitive name, IGNORING remote lists with deleted: true; unmatched local lists stay as new lists.
 *  When several remote lists share the name, the oldest (created_at, id) is used. */
export function planGuestMerge(localLists: readonly LocalListRow[], remoteLists: readonly SyncListWire[]):
  { listIdMap: Record<ListId, ListId>; newLists: ListId[] } {
  const remoteByName = new Map<string, SyncListWire>();
  for (const r of [...remoteLists].filter((x) => !x.deleted).sort(byCreated)) {
    const k = normName(r.name);
    if (!remoteByName.has(k)) remoteByName.set(k, r);
  }
  const listIdMap: Record<ListId, ListId> = {};
  const newLists: ListId[] = [];
  for (const l of localLists) {
    if (l.deleted === 1) continue;
    const r = remoteByName.get(normName(l.name));
    if (r) listIdMap[l.id] = r.id;
    else newLists.push(l.id);
  }
  return { listIdMap, newLists };
}

/** Rewrites list_id through listIdMap and sums rows that collide on (list, part, colour); base_quantity stays 0. */
export function remapGuestItems(items: readonly LocalItemRow[], listIdMap: Readonly<Record<ListId, ListId>>): LocalItemRow[] {
  const out = new Map<string, LocalItemRow>();
  for (const it of items) {
    const listId = listIdMap[it.list_id] ?? it.list_id;
    const k = keyOf(listId, it.part_id, it.color_id);
    const prev = out.get(k);
    if (prev) {
      prev.quantity = Math.min(QUANTITY_MAX, prev.quantity + it.quantity);
      prev.held = prev.held || it.held;
    } else {
      out.set(k, { list_id: listId, part_id: it.part_id, color_id: it.color_id, quantity: it.quantity,
        base_quantity: 0, held: it.held });
    }
  }
  return [...out.values()];
}

/** ≥ 1 returned item with quantity > 0 in a non-deleted list, or ≥ 1 non-deleted list named other than
 *  `defaultListName`. An account holding only an empty « Mon inventaire » has no data. */
export function accountHasData(probe: SyncResponse, defaultListName: string): boolean {
  const live = probe.lists.filter((l) => !l.deleted);
  const def = normName(defaultListName);
  if (live.some((l) => normName(l.name) !== def)) return true;
  const ids = new Set(live.map((l) => l.id));
  return probe.items.some((it) => it.quantity > 0 && ids.has(it.list_id));
}

/** Same definition on the local side (live lists, items with quantity > 0). */
export function localHasData(local: LocalState, defaultListName: string): boolean {
  const live = local.lists.filter((l) => l.deleted === 0);
  const def = normName(defaultListName);
  if (live.some((l) => normName(l.name) !== def)) return true;
  const ids = new Set(live.map((l) => l.id));
  return local.items.some((it) => it.quantity > 0 && ids.has(it.list_id));
}

/** Number of distinct local references (items with quantity > 0 in live lists): « Fusionner {n} référence(s)… ». */
export function localRefCount(local: LocalState): number {
  const ids = new Set(local.lists.filter((l) => l.deleted === 0).map((l) => l.id));
  return local.items.filter((it) => it.quantity > 0 && ids.has(it.list_id)).length;
}

/** Step-4 guard: false when meta.owner_uid changed or a wipe / keepLocalAsGuest bumped the generation since the
 *  request started — the response is then discarded. */
export function isResponseCurrent(captured: { uid: string; generation: number },
  current: { ownerUid: string | null; generation: number }): boolean {
  return current.ownerUid === captured.uid && current.generation === captured.generation;
}

/** Sign-in table, first sync of a device for an account (owner_uid null): prompt only when both sides hold data;
 *  otherwise merge silently (an empty local « Mon inventaire » collapses into the account's). */
export function planFirstSync(local: LocalState, probe: SyncResponse, defaultListName: string):
  { prompt: boolean; listIdMap: Record<ListId, ListId>; newLists: ListId[]; localRefs: number } {
  const { listIdMap, newLists } = planGuestMerge(local.lists, probe.lists);
  return {
    prompt: localHasData(local, defaultListName) && accountHasData(probe, defaultListName),
    listIdMap,
    newLists,
    localRefs: localRefCount(local),
  };
}

/** Error of the `sync` RPC as returned by supabase-js (PostgrestError + HTTP status). */
export interface RpcErrorLike { status?: number; code?: string | null; message?: string | null }
/** §4.10 step 7. offline: no HTTP status (network, abort) · needs_login: 401 / 28000 · rejected: deterministic
 *  server rejection (54000, 22xxx, 23xxx) → discard the pending batch · error: anything else (batch resent). */
export function classifySyncError(e: RpcErrorLike): 'offline' | 'needs_login' | 'rejected' | 'error' {
  const code = e.code ?? '';
  if (code === '28000' || e.status === 401) return 'needs_login';
  if (code === '54000' || /^2[23][0-9A-Z]{3}$/.test(code)) return 'rejected';
  if (!e.status) return 'offline';
  return 'error';
}

/** « il y a … » parts for SyncStatusLine. */
export function agoParts(fromIso: string, now: Date): { unit: 'now' | 'min' | 'h' | 'd'; n: number } {
  const t = parseTimestamp(fromIso);
  const diff = Number.isNaN(t) ? 0 : Math.max(0, now.getTime() - t);
  const min = Math.floor(diff / 60000);
  if (min < 1) return { unit: 'now', n: 0 };
  if (min < 60) return { unit: 'min', n: min };
  const h = Math.floor(min / 60);
  if (h < 24) return { unit: 'h', n: h };
  return { unit: 'd', n: Math.floor(h / 24) };
}
