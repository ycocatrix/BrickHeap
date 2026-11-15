// Sync scenarios of §6.1.1 and an in-memory fake of `public.sync` (migration 20261115000000_sync_catalog.sql).
// `supabase/tests/99_test.sql` asserts the very same scenarios (same ids, users, devices, batch ids, deltas and
// expected values) against PostgreSQL; `__tests__/sync.test.ts` runs them against the fake below.
// Pure TypeScript, no import outside src/domain.
import type { SyncItemWire, SyncListWire, SyncResponse } from '../types';

// ---------- identifiers shared with 99_test.sql ----------
export const IDS = {
  U: '00000000-0000-0000-0000-00000000000a',
  V: '00000000-0000-0000-0000-00000000000b',
  A: '11111111-0000-0000-0000-000000000001',
  B: '22222222-0000-0000-0000-000000000002',
  C: '33333333-0000-0000-0000-000000000003',
  L: '99999999-0000-0000-0000-000000000001',
  L2: '99999999-0000-0000-0000-000000000002',
} as const;
export const LIST_CREATED_AT = '2026-11-14T20:00:00Z';
/** Batch id `n` of device a/b/c: batch('a', 2) = 'aaaaaaaa-0000-0000-0000-000000000002'. */
export const batch = (device: 'a' | 'b' | 'c', n: number): string =>
  `${device.repeat(8)}-0000-0000-0000-${String(n).padStart(12, '0')}`;

export type Who = 'U' | 'V' | 'anon';
export type Device = 'A' | 'B' | 'C';
export interface StepList { id: string; name: string; created_at?: string; deleted?: boolean }
export interface StepItem { list: string; part: string; color: number; delta: number }

export type Step =
  | { kind: 'push'; as: Who; device: Device; batch: string;
      /** null / absent = full pull; { step } = server_time returned by that step (0-based index). */
      since?: { step: number } | null;
      lists?: StepList[]; items?: StepItem[];
      /** Generated rows for the limit scenario (S11): n lists / n item deltas on list L. */
      generate?: { lists?: number; items?: number };
      /** Expected SQLSTATE; the whole call must be rolled back. */
      error?: '54000' | '23514' | '42501' }
  | { kind: 'age'; list: string; part: string; color: number; days: number }
  | { kind: 'delete_user'; user: 'U' | 'V' };

export type Check =
  /** quantity of U's row; null = no row. */
  | { kind: 'quantity'; list: string; part: string; color: number; equals: number | null }
  | { kind: 'list'; list: string; name?: string; deleted?: boolean }
  /** exact content of a step's response (order-insensitive). */
  | { kind: 'response'; step: number; lists?: { id: string; deleted: boolean }[];
      items?: { part: string; color: number; quantity: number }[] }
  | { kind: 'rows'; user: 'U' | 'V'; lists: number; items: number; devices: number }
  /** last batch id recorded for (user, device); null = no device row. */
  | { kind: 'device_batch'; user: 'U' | 'V'; device: Device; batch: string | null };

export interface Scenario { id: string; title: string; steps: Step[]; checks: Check[] }

const L = IDS.L;
const createL: StepList = { id: L, name: 'Vrac Salon', created_at: LIST_CREATED_AT };
const s1Push: Step = { kind: 'push', as: 'U', device: 'A', batch: batch('a', 1), lists: [createL],
  items: [{ list: L, part: '3001', color: 4, delta: 3 }] };
const s3Steps: Step[] = [
  s1Push,
  { kind: 'push', as: 'U', device: 'A', batch: batch('a', 2), items: [{ list: L, part: '3001', color: 4, delta: 2 }] },
  { kind: 'push', as: 'U', device: 'B', batch: batch('b', 1), items: [{ list: L, part: '3001', color: 4, delta: -7 }] },
];
const s6Steps: Step[] = [
  s1Push,
  { kind: 'push', as: 'U', device: 'A', batch: batch('a', 2), lists: [{ ...createL, deleted: true }] },
  { kind: 'push', as: 'U', device: 'C', batch: batch('c', 1) },
];

export const SCENARIOS: readonly Scenario[] = [
  { id: 'S1', title: 'create', steps: [s1Push], checks: [
    { kind: 'quantity', list: L, part: '3001', color: 4, equals: 3 },
    { kind: 'response', step: 0, lists: [{ id: L, deleted: false }], items: [{ part: '3001', color: 4, quantity: 3 }] },
  ] },
  { id: 'S2', title: 'replay', steps: [s1Push, { ...s1Push }], checks: [
    { kind: 'quantity', list: L, part: '3001', color: 4, equals: 3 },
    { kind: 'response', step: 1, lists: [{ id: L, deleted: false }], items: [{ part: '3001', color: 4, quantity: 3 }] },
  ] },
  { id: 'S3', title: 'concurrent', steps: s3Steps, checks: [
    { kind: 'quantity', list: L, part: '3001', color: 4, equals: 0 },
  ] },
  { id: 'S4', title: 'sum', steps: [
    { kind: 'push', as: 'U', device: 'A', batch: batch('a', 1), lists: [createL],
      items: [{ list: L, part: '3020', color: 0, delta: 3 }] },
    { kind: 'push', as: 'U', device: 'B', batch: batch('b', 1), items: [{ list: L, part: '3020', color: 0, delta: 2 }] },
  ], checks: [{ kind: 'quantity', list: L, part: '3020', color: 0, equals: 5 }] },
  { id: 'S5', title: 'cap', steps: [
    { kind: 'push', as: 'U', device: 'A', batch: batch('a', 1), lists: [createL],
      items: [{ list: L, part: '3001', color: 4, delta: 99999 }] },
    { kind: 'push', as: 'U', device: 'A', batch: batch('a', 2), items: [{ list: L, part: '3001', color: 4, delta: 10 }] },
  ], checks: [{ kind: 'quantity', list: L, part: '3001', color: 4, equals: 100000 }] },
  { id: 'S6', title: 'delete list', steps: s6Steps, checks: [
    { kind: 'list', list: L, deleted: true },
    { kind: 'quantity', list: L, part: '3001', color: 4, equals: 0 },
    { kind: 'response', step: 2, lists: [{ id: L, deleted: true }], items: [] },
  ] },
  { id: 'S7', title: 'delta on deleted list', steps: [
    ...s6Steps,
    { kind: 'push', as: 'U', device: 'B', batch: batch('b', 1), items: [{ list: L, part: '3001', color: 4, delta: 1 }] },
  ], checks: [{ kind: 'quantity', list: L, part: '3001', color: 4, equals: 0 }] },
  { id: 'S8', title: 'foreign list', steps: [
    s1Push,
    { kind: 'push', as: 'V', device: 'C', batch: batch('c', 1), lists: [{ id: L, name: 'HACK' }],
      items: [{ list: L, part: '3001', color: 4, delta: 1 }] },
  ], checks: [
    { kind: 'quantity', list: L, part: '3001', color: 4, equals: 3 },
    { kind: 'list', list: L, name: 'Vrac Salon', deleted: false },
    { kind: 'response', step: 1, lists: [], items: [] },
  ] },
  { id: 'S9', title: 'full pull', steps: [
    ...s3Steps,
    { kind: 'push', as: 'U', device: 'A', batch: batch('a', 3), items: [{ list: L, part: '3020', color: 0, delta: 2 }] },
    { kind: 'push', as: 'U', device: 'C', batch: batch('c', 1) },
  ], checks: [
    { kind: 'response', step: 4, lists: [{ id: L, deleted: false }], items: [{ part: '3020', color: 0, quantity: 2 }] },
  ] },
  { id: 'S10', title: 'incremental pull', steps: [
    { kind: 'push', as: 'U', device: 'A', batch: batch('a', 1), lists: [createL], items: [
      { list: L, part: '3001', color: 4, delta: 3 }, { list: L, part: '3020', color: 0, delta: 1 }] },
    { kind: 'push', as: 'U', device: 'B', batch: batch('b', 1), since: { step: 0 },
      items: [{ list: L, part: '3001', color: 4, delta: 1 }] },
  ], checks: [
    { kind: 'response', step: 1, lists: [], items: [{ part: '3001', color: 4, quantity: 4 }] },
  ] },
  { id: 'S11', title: 'limits', steps: [
    { kind: 'push', as: 'U', device: 'A', batch: batch('a', 1), generate: { lists: 201 }, error: '54000' },
    { kind: 'push', as: 'U', device: 'A', batch: batch('a', 2), lists: [createL], generate: { items: 5001 },
      error: '54000' },
  ], checks: [
    { kind: 'rows', user: 'U', lists: 0, items: 0, devices: 0 },
  ] },
  { id: 'S12', title: 'invalid row', steps: [
    { kind: 'push', as: 'U', device: 'A', batch: batch('a', 1), lists: [{ ...createL, name: 'x'.repeat(61) }],
      items: [{ list: L, part: '3001', color: 4, delta: 3 }], error: '23514' },
    { kind: 'push', as: 'U', device: 'A', batch: batch('a', 1), lists: [{ ...createL, name: 'x'.repeat(60) }],
      items: [{ list: L, part: '3001', color: 4, delta: 3 }] },
  ], checks: [
    { kind: 'quantity', list: L, part: '3001', color: 4, equals: 3 },
    { kind: 'list', list: L, name: 'x'.repeat(60), deleted: false },
    { kind: 'device_batch', user: 'U', device: 'A', batch: batch('a', 1) },
  ] },
  { id: 'S13', title: 'purge', steps: [
    ...s3Steps,
    { kind: 'age', list: L, part: '3001', color: 4, days: 91 },
    { kind: 'push', as: 'U', device: 'C', batch: batch('c', 1) },
  ], checks: [{ kind: 'quantity', list: L, part: '3001', color: 4, equals: null }] },
  { id: 'S14', title: 'anon', steps: [
    { kind: 'push', as: 'anon', device: 'A', batch: batch('a', 1), lists: [createL], error: '42501' },
  ], checks: [{ kind: 'rows', user: 'U', lists: 0, items: 0, devices: 0 }] },
  { id: 'S15', title: 'cascade', steps: [
    s1Push,
    { kind: 'delete_user', user: 'U' },
  ], checks: [{ kind: 'rows', user: 'U', lists: 0, items: 0, devices: 0 }] },
];

// ---------- in-memory fake of public.sync ----------
interface FList { id: string; user_id: string; name: string; created_at: string; updated: number; deleted_at: number | null }
interface FItem { user_id: string; list_id: string; part_id: string; color_id: number; quantity: number; updated: number }
interface FDevice { user_id: string; device_id: string; last_batch_id: string; last_sync: number }
interface FState { lists: FList[]; items: FItem[]; devices: FDevice[] }

export class SqlStateError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export interface SyncArgs {
  p_device_id: string; p_batch_id: string; p_since?: string | null;
  p_lists?: { id: string; name: string; created_at?: string | null; deleted?: boolean | null }[];
  p_items?: { list_id: string; part_id: string; color_id: number; delta: number }[];
}

const DAY = 86400000;
const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
/** Postgres-like timestamptz text with microseconds and offset. */
export function fakeTimestamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:`
    + `${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}000+00:00`;
}
function parseFakeTimestamp(s: string): number {
  const t = Date.parse(s.replace(/(\.\d{3})\d*/, '$1'));
  if (Number.isNaN(t)) throw new SqlStateError('22007', `invalid timestamp ${s}`);
  return t;
}
const keyOf = (l: string, p: string, c: number): string => `${l}|${p}|${c}`;
const chars = (s: string): number => Array.from(s).length;

/** Same semantics as public.sync: idempotent per (user, device, batch), list name last-push-wins, a delete is
 *  final and zeroes the items, deltas summed and floored at 0 / capped at 100000, tombstones purged after 90 days,
 *  whole call rolled back on any error. `uid` null = anon (no execute grant → 42501). */
export class FakeSyncServer {
  private state: FState = { lists: [], items: [], devices: [] };
  private clock: number;

  constructor(startMs = Date.UTC(2026, 10, 15, 8, 0, 0)) { this.clock = startMs; }

  /** Strictly increasing clock_timestamp(). */
  private tick(): number { this.clock += 1000; return this.clock; }

  sync(uid: string | null, args: SyncArgs): SyncResponse {
    if (uid === null) throw new SqlStateError('42501', 'permission denied for function sync');
    const pLists = args.p_lists ?? [];
    const pItems = args.p_items ?? [];
    if (pLists.length > 200 || pItems.length > 5000) throw new SqlStateError('54000', 'batch too large');
    const since = args.p_since == null ? null : parseFakeTimestamp(args.p_since);
    const snapshot = JSON.parse(JSON.stringify(this.state)) as FState;
    try {
      const now = this.tick();
      const s = this.state;
      const done = s.devices.some((d) => d.user_id === uid && d.device_id === args.p_device_id
        && d.last_batch_id === args.p_batch_id);
      if (!done) {
        for (const l of pLists) {
          if (typeof l.name !== 'string') throw new SqlStateError('23502', 'null name');
          if (chars(l.name) < 1 || chars(l.name) > 60) throw new SqlStateError('23514', 'lists_name_len');
          const t = s.lists.find((x) => x.id === l.id);
          const del = l.deleted ? now : null;
          if (!t) {
            s.lists.push({ id: l.id, user_id: uid, name: l.name, created_at: l.created_at ?? fakeTimestamp(now),
              updated: now, deleted_at: del });
          } else if (t.user_id === uid) {
            t.name = l.name;
            t.updated = now;
            t.deleted_at = t.deleted_at ?? del;
          }
        }
        for (const i of s.items) {
          const l = s.lists.find((x) => x.id === i.list_id);
          if (l && l.user_id === uid && l.deleted_at === now && i.quantity > 0) {
            i.quantity = 0;
            i.updated = now;
          }
        }
        const sums = new Map<string, { list_id: string; part_id: string; color_id: number; delta: number }>();
        for (const x of pItems) {
          const l = s.lists.find((y) => y.id === x.list_id);
          if (!l || l.user_id !== uid || l.deleted_at !== null) continue;
          const k = keyOf(x.list_id, x.part_id, x.color_id);
          const prev = sums.get(k);
          if (prev) prev.delta += x.delta;
          else sums.set(k, { list_id: x.list_id, part_id: x.part_id, color_id: x.color_id, delta: x.delta });
        }
        for (const d of sums.values()) {
          if (d.delta === 0) continue;
          const i = s.items.find((y) => y.list_id === d.list_id && y.part_id === d.part_id && y.color_id === d.color_id);
          if (i) {
            i.quantity = Math.min(Math.max(i.quantity + d.delta, 0), 100000);
            i.updated = now;
          } else if (d.delta > 0) {
            if (chars(d.part_id) < 1 || chars(d.part_id) > 40) throw new SqlStateError('23514', 'inventory_items_part_len');
            s.items.push({ user_id: uid, list_id: d.list_id, part_id: d.part_id, color_id: d.color_id,
              quantity: Math.min(d.delta, 100000), updated: now });
          }
        }
        const dev = s.devices.find((d) => d.user_id === uid && d.device_id === args.p_device_id);
        if (dev) {
          dev.last_batch_id = args.p_batch_id;
          dev.last_sync = now;
        } else {
          s.devices.push({ user_id: uid, device_id: args.p_device_id, last_batch_id: args.p_batch_id, last_sync: now });
        }
        s.items = s.items.filter((i) => !(i.user_id === uid && i.quantity === 0 && i.updated < now - 90 * DAY));
      }
      const lists: SyncListWire[] = s.lists
        .filter((l) => l.user_id === uid && (since === null || l.updated > since))
        .map((l) => ({ id: l.id, name: l.name, created_at: l.created_at, deleted: l.deleted_at !== null }));
      const items: SyncItemWire[] = s.items
        .filter((i) => i.user_id === uid && ((since === null && i.quantity > 0) || (since !== null && i.updated > since)))
        .map((i) => ({ list_id: i.list_id, part_id: i.part_id, color_id: i.color_id, quantity: i.quantity }));
      return { server_time: fakeTimestamp(now), lists, items };
    } catch (e) {
      this.state = snapshot;
      throw e;
    }
  }

  /** Test helper (superuser): moves an item's updated_at `days` into the past. */
  age(listId: string, partId: string, colorId: number, days: number): void {
    for (const i of this.state.items) {
      if (i.list_id === listId && i.part_id === partId && i.color_id === colorId) i.updated -= days * DAY;
    }
  }

  /** `delete from auth.users` with its cascades. */
  deleteUser(uid: string): void {
    this.state.lists = this.state.lists.filter((l) => l.user_id !== uid);
    this.state.items = this.state.items.filter((i) => i.user_id !== uid);
    this.state.devices = this.state.devices.filter((d) => d.user_id !== uid);
  }

  quantity(listId: string, partId: string, colorId: number): number | null {
    const i = this.state.items.find((x) => x.list_id === listId && x.part_id === partId && x.color_id === colorId);
    return i ? i.quantity : null;
  }
  list(id: string): { name: string; deleted: boolean; userId: string } | null {
    const l = this.state.lists.find((x) => x.id === id);
    return l ? { name: l.name, deleted: l.deleted_at !== null, userId: l.user_id } : null;
  }
  rows(uid: string): { lists: number; items: number; devices: number } {
    return {
      lists: this.state.lists.filter((l) => l.user_id === uid).length,
      items: this.state.items.filter((i) => i.user_id === uid).length,
      devices: this.state.devices.filter((d) => d.user_id === uid).length,
    };
  }
  deviceBatch(uid: string, deviceId: string): string | null {
    return this.state.devices.find((d) => d.user_id === uid && d.device_id === deviceId)?.last_batch_id ?? null;
  }
}

// ---------- scenario runner ----------
export interface StepOutcome { response: SyncResponse | null; error: string | null }

function whoId(who: Who): string | null {
  return who === 'anon' ? null : IDS[who];
}

/** Arguments of a push step, exactly as 99_test.sql passes them. */
export function pushArgs(step: Extract<Step, { kind: 'push' }>, outcomes: readonly StepOutcome[]): SyncArgs {
  const lists: NonNullable<SyncArgs['p_lists']> = (step.lists ?? []).map((l) => ({
    id: l.id, name: l.name, created_at: l.created_at ?? null, deleted: l.deleted ?? false }));
  const items: NonNullable<SyncArgs['p_items']> = (step.items ?? []).map((i) => ({
    list_id: i.list, part_id: i.part, color_id: i.color, delta: i.delta }));
  for (let n = 1; n <= (step.generate?.lists ?? 0); n++) {
    lists.push({ id: `99999999-0000-0000-0001-${String(n).padStart(12, '0')}`, name: `L${n}`, created_at: null,
      deleted: false });
  }
  for (let n = 1; n <= (step.generate?.items ?? 0); n++) {
    items.push({ list_id: IDS.L, part_id: `p${n}`, color_id: 0, delta: 1 });
  }
  const since = step.since ? outcomes[step.since.step]?.response?.server_time ?? null : null;
  return { p_device_id: IDS[step.device], p_batch_id: step.batch, p_since: since, p_lists: lists, p_items: items };
}

export function runScenario(scenario: Scenario, server: FakeSyncServer = new FakeSyncServer()): StepOutcome[] {
  const outcomes: StepOutcome[] = [];
  for (const step of scenario.steps) {
    if (step.kind === 'age') {
      server.age(step.list, step.part, step.color, step.days);
      outcomes.push({ response: null, error: null });
    } else if (step.kind === 'delete_user') {
      server.deleteUser(IDS[step.user]);
      outcomes.push({ response: null, error: null });
    } else {
      try {
        outcomes.push({ response: server.sync(whoId(step.as), pushArgs(step, outcomes)), error: null });
      } catch (e) {
        if (!(e instanceof SqlStateError)) throw e;
        outcomes.push({ response: null, error: e.code });
      }
    }
  }
  return outcomes;
}

/** Evaluates every check of a scenario; returns the failures (empty = pass). Step error expectations included. */
export function checkScenario(scenario: Scenario, server: FakeSyncServer, outcomes: readonly StepOutcome[]): string[] {
  const failures: string[] = [];
  const fail = (msg: string): void => { failures.push(`${scenario.id}: ${msg}`); };
  scenario.steps.forEach((step, i) => {
    if (step.kind !== 'push') return;
    const got = outcomes[i]?.error ?? null;
    if ((step.error ?? null) !== got) fail(`step ${i} expected error ${step.error ?? 'none'}, got ${got ?? 'none'}`);
  });
  const sortItems = (a: { part: string; color: number }, b: { part: string; color: number }): number =>
    a.part === b.part ? a.color - b.color : a.part < b.part ? -1 : 1;
  for (const c of scenario.checks) {
    switch (c.kind) {
      case 'quantity': {
        const q = server.quantity(c.list, c.part, c.color);
        if (q !== c.equals) fail(`quantity ${c.part}/${c.color} = ${q}, expected ${c.equals}`);
        break;
      }
      case 'list': {
        const l = server.list(c.list);
        if (!l) { fail(`list ${c.list} missing`); break; }
        if (c.name !== undefined && l.name !== c.name) fail(`list name ${l.name}, expected ${c.name}`);
        if (c.deleted !== undefined && l.deleted !== c.deleted) fail(`list deleted ${l.deleted}, expected ${c.deleted}`);
        break;
      }
      case 'response': {
        const r = outcomes[c.step]?.response;
        if (!r) { fail(`step ${c.step} has no response`); break; }
        if (c.lists) {
          const got = JSON.stringify(r.lists.map((l) => ({ id: l.id, deleted: l.deleted })).sort((a, b) => (a.id < b.id ? -1 : 1)));
          const want = JSON.stringify([...c.lists].sort((a, b) => (a.id < b.id ? -1 : 1)));
          if (got !== want) fail(`step ${c.step} lists ${got}, expected ${want}`);
        }
        if (c.items) {
          const got = JSON.stringify(r.items.map((i) => ({ part: i.part_id, color: i.color_id, quantity: i.quantity })).sort(sortItems));
          const want = JSON.stringify([...c.items].sort(sortItems));
          if (got !== want) fail(`step ${c.step} items ${got}, expected ${want}`);
        }
        break;
      }
      case 'rows': {
        const r = server.rows(IDS[c.user]);
        if (r.lists !== c.lists || r.items !== c.items || r.devices !== c.devices) {
          fail(`rows ${JSON.stringify(r)}, expected ${JSON.stringify({ lists: c.lists, items: c.items, devices: c.devices })}`);
        }
        break;
      }
      case 'device_batch': {
        const b = server.deviceBatch(IDS[c.user], IDS[c.device]);
        if (b !== c.batch) fail(`device batch ${b}, expected ${c.batch}`);
        break;
      }
    }
  }
  return failures;
}
