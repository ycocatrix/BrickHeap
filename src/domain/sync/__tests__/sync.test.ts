import type { SyncBatch, SyncResponse } from '../../types';
import {
  BATCH_LIMITS, accountHasData, agoParts, applyResponse, buildBatch, classifySyncError, dedupeListNames,
  isEmptyBatch, isResponseCurrent, localHasData, needsFullPull, parseTimestamp, pendingCount, planFirstSync,
  planGuestMerge, remapGuestItems, type ApplyPlan, type LocalItemRow, type LocalListRow, type LocalState,
} from '../sync';
import { FakeSyncServer, IDS, SCENARIOS, checkScenario, runScenario } from '../scenarios';

// Node built-ins without @types/node (not a dependency): minimal local declarations, Jest runs under Node.
declare function require(module: 'fs'): { readFileSync(path: string, encoding: 'utf8'): string };
declare const __dirname: string;

const DEFAULT = 'Mon inventaire';
const T0 = '2026-11-14T20:00:00Z';
const list = (id: string, name: string, o: Partial<LocalListRow> = {}): LocalListRow =>
  ({ id, name, created_at: T0, deleted: 0, dirty: 0, ...o });
const item = (listId: string, part: string, color: number, quantity: number, base = 0, held = false): LocalItemRow =>
  ({ list_id: listId, part_id: part, color_id: color, quantity, base_quantity: base, held });
const empty: SyncBatch = { batchId: 'b0', lists: [], items: [] };
const resp = (o: Partial<SyncResponse> = {}): SyncResponse =>
  ({ server_time: '2026-11-15T10:00:00.123456+00:00', lists: [], items: [], ...o });
const itemOf = (plan: ApplyPlan, listId: string, part: string, color: number): LocalItemRow | undefined =>
  plan.upsertItems.find((i) => i.list_id === listId && i.part_id === part && i.color_id === color);

describe('buildBatch', () => {
  it('sends dirty lists and deltas of changed items only', () => {
    const local: LocalState = {
      lists: [list('L1', 'A', { dirty: 1 }), list('L2', 'B')],
      items: [item('L1', '3001', 4, 5, 2), item('L2', '3020', 0, 3, 3), item('L2', '3023', 1, 0, 4)],
    };
    const { batch, more, invalid } = buildBatch(local, 'batch-1');
    expect(batch.batchId).toBe('batch-1');
    expect(batch.lists).toEqual([{ id: 'L1', name: 'A', created_at: T0, deleted: false }]);
    expect(batch.items).toEqual([
      { list_id: 'L1', part_id: '3001', color_id: 4, delta: 3 },
      { list_id: 'L2', part_id: '3023', color_id: 1, delta: -4 },
    ]);
    expect(more).toBe(false);
    expect(invalid).toEqual({ lists: [], items: [] });
  });

  it('sends tombstones and excludes items of deleted lists', () => {
    const local: LocalState = {
      lists: [list('L1', 'A', { deleted: 1, dirty: 1 }), list('L2', 'B')],
      items: [item('L1', '3001', 4, 5), item('L2', '3001', 4, 1)],
    };
    const { batch } = buildBatch(local, 'b');
    expect(batch.lists).toEqual([{ id: 'L1', name: 'A', created_at: T0, deleted: true }]);
    expect(batch.items).toEqual([{ list_id: 'L2', part_id: '3001', color_id: 4, delta: 1 }]);
  });

  it('holds back pending provisional parts but counts them in awaitingCatalog', () => {
    const local: LocalState = {
      lists: [list('L1', 'A')],
      items: [item('L1', '3001', 4, 2), item('L1', 'bl-123', 4, 1, 0, true)],
    };
    expect(buildBatch(local, 'b').batch.items.map((i) => i.part_id)).toEqual(['3001']);
    expect(pendingCount(local)).toEqual({ pending: 2, awaitingCatalog: 1 });
  });

  it('chunks at BATCH_LIMITS.items and reports more', () => {
    const items = Array.from({ length: BATCH_LIMITS.items + 5 }, (_, n) => item('L1', `p${n}`, 0, 1));
    const { batch, more } = buildBatch({ lists: [list('L1', 'A')], items }, 'b');
    expect(batch.items).toHaveLength(BATCH_LIMITS.items);
    expect(more).toBe(true);
  });

  it('chunks lists at BATCH_LIMITS.lists and defers items of unsent dirty lists', () => {
    const lists = Array.from({ length: BATCH_LIMITS.lists + 1 }, (_, n) =>
      list(`L${String(n).padStart(3, '0')}`, `N${n}`, { dirty: 1 }));
    const last = lists[lists.length - 1].id;
    const { batch, more } = buildBatch({ lists, items: [item(last, '3001', 4, 1)] }, 'b');
    expect(batch.lists).toHaveLength(BATCH_LIMITS.lists);
    expect(batch.items).toHaveLength(0);
    expect(more).toBe(true);
  });

  it('reports a 61-character name and a 41-character part id as invalid', () => {
    const local: LocalState = {
      lists: [list('L1', 'x'.repeat(61), { dirty: 1 }), list('L2', 'ok')],
      items: [item('L2', 'p'.repeat(41), 0, 1), item('L2', 'p'.repeat(40), 0, 1), item('L1', '3001', 4, 1)],
    };
    const { batch, invalid } = buildBatch(local, 'b');
    expect(batch.lists).toEqual([]);
    expect(batch.items.map((i) => i.part_id)).toEqual(['p'.repeat(40)]);
    expect(invalid.lists).toEqual(['L1']);
    expect(invalid.items).toEqual([
      { listId: 'L2', partId: 'p'.repeat(41), colorId: 0 },
      { listId: 'L1', partId: '3001', colorId: 4 },
    ]);
  });

  it('counts names in code points like Postgres char_length', () => {
    const name = 'é'.repeat(60);
    expect(buildBatch({ lists: [list('L1', name, { dirty: 1 })], items: [] }, 'b').batch.lists).toHaveLength(1);
    expect(buildBatch({ lists: [list('L1', '   ', { dirty: 1 })], items: [] }, 'b').invalid.lists).toEqual(['L1']);
  });

  it('clamps deltas to ±deltaMax', () => {
    const local: LocalState = { lists: [list('L1', 'A')], items: [item('L1', '3001', 4, 100000, -50000)] };
    expect(buildBatch(local, 'b').batch.items[0].delta).toBe(BATCH_LIMITS.deltaMax);
  });

  it('isEmptyBatch', () => {
    expect(isEmptyBatch(empty)).toBe(true);
    expect(isEmptyBatch({ ...empty, items: [{ list_id: 'L', part_id: 'p', color_id: 0, delta: 1 }] })).toBe(false);
  });
});

describe('applyResponse', () => {
  const sentPlus3: SyncBatch = { batchId: 'b1', lists: [], items: [{ list_id: 'L1', part_id: '3001', color_id: 4, delta: 3 }] };

  it('acknowledges sent deltas and stores since verbatim', () => {
    const local: LocalState = { lists: [list('L1', 'A')], items: [item('L1', '3001', 4, 3, 0)] };
    const plan = applyResponse(local, sentPlus3, resp({ items: [{ list_id: 'L1', part_id: '3001', color_id: 4, quantity: 3 }] }), false);
    expect(itemOf(plan, 'L1', '3001', 4)).toMatchObject({ quantity: 3, base_quantity: 3 });
    expect(plan.since).toBe('2026-11-15T10:00:00.123456+00:00');
  });

  it('preserves an edit made during the request (quantity = S + localDelta)', () => {
    // sent +3, then the user added 2 more while the request was in flight; another device added 4.
    const local: LocalState = { lists: [list('L1', 'A')], items: [item('L1', '3001', 4, 5, 0)] };
    const plan = applyResponse(local, sentPlus3, resp({ items: [{ list_id: 'L1', part_id: '3001', color_id: 4, quantity: 7 }] }), false);
    expect(itemOf(plan, 'L1', '3001', 4)).toMatchObject({ quantity: 9, base_quantity: 7 });
  });

  it('deletes a row when the server says 0 and there is no local delta', () => {
    const local: LocalState = { lists: [list('L1', 'A')], items: [item('L1', '3001', 4, 2, 2)] };
    const plan = applyResponse(local, empty, resp({ items: [{ list_id: 'L1', part_id: '3001', color_id: 4, quantity: 0 }] }), false);
    expect(plan.deleteItems).toEqual([{ listId: 'L1', partId: '3001', colorId: 4 }]);
    expect(plan.upsertItems).toEqual([]);
  });

  it('a returned deleted list removes the list and its items', () => {
    const local: LocalState = { lists: [list('L1', 'A'), list('L2', 'B')], items: [item('L1', '3001', 4, 2, 2)] };
    const plan = applyResponse(local, empty, resp({
      lists: [{ id: 'L1', name: 'A', created_at: T0, deleted: true }],
      items: [{ list_id: 'L1', part_id: '3001', color_id: 4, quantity: 0 }],
    }), false);
    expect(plan.deleteLists).toEqual(['L1']);
    expect(plan.upsertItems).toEqual([]);
    expect(plan.deleteItems).toEqual([]);
  });

  it('keeps a list renamed locally during the request dirty', () => {
    const sent: SyncBatch = { batchId: 'b', lists: [{ id: 'L1', name: 'Old', created_at: T0, deleted: false }], items: [] };
    const local: LocalState = { lists: [list('L1', 'New', { dirty: 1 })], items: [] };
    const plan = applyResponse(local, sent, resp({ lists: [{ id: 'L1', name: 'Old', created_at: T0, deleted: false }] }), false);
    expect(plan.upsertLists).toEqual([]); // unchanged: still 'New', dirty 1
  });

  it('clears dirty on a sent list not edited meanwhile', () => {
    const sent: SyncBatch = { batchId: 'b', lists: [{ id: 'L1', name: 'A', created_at: T0, deleted: false }], items: [] };
    const local: LocalState = { lists: [list('L1', 'A', { dirty: 1 })], items: [] };
    const plan = applyResponse(local, sent, resp({ lists: [{ id: 'L1', name: 'A', created_at: T0, deleted: false }] }), false);
    expect(plan.upsertLists).toEqual([list('L1', 'A', { dirty: 0 })]);
  });

  it('a sent tombstone is deleted locally', () => {
    const sent: SyncBatch = { batchId: 'b', lists: [{ id: 'L1', name: 'A', created_at: T0, deleted: true }], items: [] };
    const local: LocalState = { lists: [list('L1', 'A', { deleted: 1, dirty: 1 }), list('L2', 'B')], items: [] };
    expect(applyResponse(local, sent, resp(), false).deleteLists).toEqual(['L1']);
  });

  it('a returned list dirty locally but not in `sent` keeps its local values', () => {
    const local: LocalState = { lists: [list('L1', 'Local', { dirty: 1 })], items: [] };
    const plan = applyResponse(local, empty, resp({ lists: [{ id: 'L1', name: 'Remote', created_at: T0, deleted: false }] }), false);
    expect(plan.upsertLists).toEqual([]);
  });

  it('takes the server name of a clean list and inserts unknown lists clean', () => {
    const local: LocalState = { lists: [list('L1', 'Old')], items: [] };
    const plan = applyResponse(local, empty, resp({ lists: [
      { id: 'L1', name: 'Renamed', created_at: T0, deleted: false },
      { id: 'L9', name: 'Other', created_at: T0, deleted: false },
    ] }), false);
    expect(plan.upsertLists).toEqual([list('L1', 'Renamed'), list('L9', 'Other')]);
  });

  it('full pull drops stale synced rows but keeps unsynced ones', () => {
    const local: LocalState = {
      lists: [list('L1', 'A')],
      items: [item('L1', 'stale', 0, 2, 2), item('L1', 'new', 0, 1, 0), item('L1', 'edited', 0, 4, 2),
        item('L1', 'kept', 0, 5, 5)],
    };
    const plan = applyResponse(local, empty, resp({
      lists: [{ id: 'L1', name: 'A', created_at: T0, deleted: false }],
      items: [{ list_id: 'L1', part_id: 'kept', color_id: 0, quantity: 5 }],
    }), true);
    expect(plan.deleteItems).toEqual([{ listId: 'L1', partId: 'stale', colorId: 0 }]);
    expect(plan.upsertItems.map((i) => i.part_id)).toEqual(['kept']);
  });

  it('an incremental pull never drops absent rows', () => {
    const local: LocalState = { lists: [list('L1', 'A')], items: [item('L1', 'x', 0, 2, 2)] };
    expect(applyResponse(local, empty, resp(), false).deleteItems).toEqual([]);
  });

  it('undo while in flight: row gone locally, S = 3 → q 0 / base 3, next batch −3', () => {
    const local: LocalState = { lists: [list('L1', 'A')], items: [] };
    const plan = applyResponse(local, sentPlus3, resp({ items: [{ list_id: 'L1', part_id: '3001', color_id: 4, quantity: 3 }] }), false);
    const row = itemOf(plan, 'L1', '3001', 4)!;
    expect(row).toMatchObject({ quantity: 0, base_quantity: 3 });
    expect(buildBatch({ lists: local.lists, items: [row] }, 'next').batch.items).toEqual([
      { list_id: 'L1', part_id: '3001', color_id: 4, delta: -3 },
    ]);
  });

  it('resend of a pending batch after the item was removed locally', () => {
    // pending batch (+3) was persisted, the app was killed, the user then removed the item (never synced → row
    // deleted). The resend is acknowledged; server answers 3 → q 0 / base 3 → next batch −3 restores 0.
    const local: LocalState = { lists: [list('L1', 'A')], items: [] };
    const plan = applyResponse(local, sentPlus3, resp({ items: [{ list_id: 'L1', part_id: '3001', color_id: 4, quantity: 3 }] }), false);
    expect(itemOf(plan, 'L1', '3001', 4)).toMatchObject({ quantity: 0, base_quantity: 3 });
    // replayed batch already applied server-side, no item returned (incremental pull): acknowledged only.
    const plan2 = applyResponse(local, sentPlus3, resp(), false);
    expect(itemOf(plan2, 'L1', '3001', 4)).toMatchObject({ quantity: 0, base_quantity: 3 });
  });

  it('never upserts a returned item of a locally tombstoned list', () => {
    const local: LocalState = { lists: [list('L1', 'A', { deleted: 1, dirty: 1 })], items: [] };
    const plan = applyResponse(local, empty, resp({
      lists: [{ id: 'L1', name: 'A', created_at: T0, deleted: false }],
      items: [{ list_id: 'L1', part_id: '3001', color_id: 4, quantity: 2 }],
    }), false);
    expect(plan.upsertItems).toEqual([]);
    expect(plan.upsertLists).toEqual([]);
  });

  it('dedupes colliding names after the merge of remote lists', () => {
    const local: LocalState = { lists: [list('L1', DEFAULT, { created_at: '2026-11-14T21:00:00Z', dirty: 1 })], items: [] };
    const plan = applyResponse(local, empty, resp({ lists: [{ id: 'L0', name: DEFAULT, created_at: T0, deleted: false }] }), false);
    expect(plan.upsertLists).toEqual(expect.arrayContaining([
      list('L0', DEFAULT),
      list('L1', `${DEFAULT} (2)`, { created_at: '2026-11-14T21:00:00Z', dirty: 1 }),
    ]));
  });
});

describe('dedupeListNames', () => {
  const a = list('id-a', 'Mon inventaire', { created_at: '2026-11-01T00:00:00Z' });
  const b = list('id-b', 'mon inventaire ', { created_at: '2026-11-02T00:00:00Z' });
  it('the older keeps the name, the other gets (2) and dirty, whatever the order', () => {
    const expected = [{ ...b, name: 'mon inventaire (2)', dirty: 1 }];
    expect(dedupeListNames([a, b])).toEqual(expected);
    expect(dedupeListNames([b, a])).toEqual(expected);
  });
  it('ties on created_at are broken by id and taken suffixes are skipped', () => {
    const x = list('x', 'Vrac');
    const y = list('y', 'vrac');
    const z = list('z', 'Vrac (2)');
    expect(dedupeListNames([z, y, x])).toEqual([{ ...y, name: 'vrac (3)', dirty: 1 }]);
  });
  it('truncates to 60 characters and ignores tombstones', () => {
    const long = 'L'.repeat(60);
    const out = dedupeListNames([list('a', long), list('b', long), list('c', long, { deleted: 1 })]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('L'.repeat(56) + ' (2)');
    expect(Array.from(out[0].name)).toHaveLength(60);
  });
});

describe('needsFullPull / parseTimestamp', () => {
  const now = new Date('2026-11-15T12:00:00Z');
  const daysAgo = (d: number): string => new Date(now.getTime() - d * 86400000).toISOString().replace('Z', '+00:00');
  it('null, 59 days, 61 days', () => {
    expect(needsFullPull(null, now)).toBe(true);
    expect(needsFullPull(daysAgo(59), now)).toBe(false);
    expect(needsFullPull(daysAgo(61), now)).toBe(true);
    expect(needsFullPull('garbage', now)).toBe(true);
  });
  it('parses Postgres timestamptz text with microseconds and offsets', () => {
    expect(parseTimestamp('2026-11-14T21:03:11.120534+00:00')).toBe(Date.UTC(2026, 10, 14, 21, 3, 11, 120));
    expect(parseTimestamp('2026-11-14 23:03:11+02')).toBe(Date.UTC(2026, 10, 14, 21, 3, 11));
    expect(parseTimestamp('2026-11-14T21:03:11Z')).toBe(Date.UTC(2026, 10, 14, 21, 3, 11));
  });
});

describe('guest merge', () => {
  it('planGuestMerge matches trimmed case-insensitive names, ignores deleted remote lists', () => {
    const local = [list('g1', 'Mon inventaire'), list('g2', 'Vrac'), list('g3', 'Lego Technic'), list('g4', 'Old', { deleted: 1 })];
    const remote = [
      { id: 'r1', name: 'mon inventaire  ', created_at: T0, deleted: false },
      { id: 'r2', name: 'Lego technic', created_at: T0, deleted: true },
    ];
    expect(planGuestMerge(local, remote)).toEqual({ listIdMap: { g1: 'r1' }, newLists: ['g2', 'g3'] });
  });

  it('remapGuestItems sums collisions and keeps base_quantity 0', () => {
    const items = [item('g1', '3001', 4, 2), item('g2', '3001', 4, 3), item('g2', '3020', 0, 1, 0, true)];
    expect(remapGuestItems(items, { g1: 'r1', g2: 'r1' })).toEqual([
      item('r1', '3001', 4, 5), item('r1', '3020', 0, 1, 0, true),
    ]);
  });

  it('accountHasData / localHasData: only an empty default list → false', () => {
    const def = resp({ lists: [{ id: 'r1', name: DEFAULT, created_at: T0, deleted: false }] });
    expect(accountHasData(def, DEFAULT)).toBe(false);
    expect(accountHasData({ ...def, items: [{ list_id: 'r1', part_id: '3001', color_id: 4, quantity: 1 }] }, DEFAULT)).toBe(true);
    expect(accountHasData(resp({ lists: [{ id: 'r2', name: 'Vrac', created_at: T0, deleted: false }] }), DEFAULT)).toBe(true);
    expect(accountHasData(resp({ lists: [{ id: 'r2', name: 'Vrac', created_at: T0, deleted: true }] }), DEFAULT)).toBe(false);
    expect(localHasData({ lists: [list('g1', DEFAULT)], items: [item('g1', '3001', 4, 0)] }, DEFAULT)).toBe(false);
    expect(localHasData({ lists: [list('g1', DEFAULT)], items: [item('g1', '3001', 4, 1)] }, DEFAULT)).toBe(true);
    expect(localHasData({ lists: [list('g1', 'Vrac')], items: [] }, DEFAULT)).toBe(true);
  });

  it('first sync with an existing remote « Mon inventaire »: local empty default collapses into it, no prompt', () => {
    const local: LocalState = { lists: [list('g1', DEFAULT, { dirty: 1 })], items: [] };
    const probe = resp({
      lists: [{ id: 'r1', name: DEFAULT, created_at: T0, deleted: false }],
      items: [{ list_id: 'r1', part_id: '3001', color_id: 4, quantity: 2 }],
    });
    const first = planFirstSync(local, probe, DEFAULT);
    expect(first.prompt).toBe(false);
    expect(first.listIdMap).toEqual({ g1: 'r1' });
    // After the remap (local g1 dropped) the probe is applied as a full pull: exactly one list.
    const plan = applyResponse({ lists: [], items: [] }, empty, probe, true);
    expect(plan.upsertLists).toEqual([list('r1', DEFAULT)]);
    expect(itemOf(plan, 'r1', '3001', 4)).toMatchObject({ quantity: 2, base_quantity: 2 });
  });

  it('first sync, both sides hold data → prompt; merge adds local quantities through the next push', () => {
    const local: LocalState = { lists: [list('g1', DEFAULT, { dirty: 1 })], items: [item('g1', '3001', 4, 3)] };
    const probe = resp({
      lists: [{ id: 'r1', name: DEFAULT, created_at: T0, deleted: false }],
      items: [{ list_id: 'r1', part_id: '3001', color_id: 4, quantity: 2 }],
    });
    const first = planFirstSync(local, probe, DEFAULT);
    expect(first.prompt).toBe(true);
    expect(first.localRefs).toBe(1);
    const remapped = remapGuestItems(local.items, first.listIdMap);
    const plan = applyResponse({ lists: [], items: remapped }, empty, probe, true);
    const row = itemOf(plan, 'r1', '3001', 4)!;
    expect(row).toMatchObject({ quantity: 5, base_quantity: 2 });
    expect(buildBatch({ lists: plan.upsertLists, items: [row] }, 'n').batch.items[0].delta).toBe(3);
  });

  it('first sync, empty local and an account with data → no prompt', () => {
    const probe = resp({ lists: [{ id: 'r1', name: 'Vrac', created_at: T0, deleted: false }] });
    expect(planFirstSync({ lists: [], items: [] }, probe, DEFAULT).prompt).toBe(false);
  });
});

describe('guards and helpers', () => {
  it('isResponseCurrent: uid change and generation bump', () => {
    const cap = { uid: 'u1', generation: 3 };
    expect(isResponseCurrent(cap, { ownerUid: 'u1', generation: 3 })).toBe(true);
    expect(isResponseCurrent(cap, { ownerUid: 'u2', generation: 3 })).toBe(false);
    expect(isResponseCurrent(cap, { ownerUid: null, generation: 3 })).toBe(false);
    expect(isResponseCurrent(cap, { ownerUid: 'u1', generation: 4 })).toBe(false);
  });

  it('classifySyncError', () => {
    expect(classifySyncError({ status: 0, code: '', message: 'FetchError: Network request failed' })).toBe('offline');
    expect(classifySyncError({ status: 0, code: '', message: 'AbortError: Aborted' })).toBe('offline');
    expect(classifySyncError({ status: 401, code: '42501' })).toBe('needs_login');
    expect(classifySyncError({ status: 400, code: '28000' })).toBe('needs_login');
    expect(classifySyncError({ status: 400, code: '54000' })).toBe('rejected');
    expect(classifySyncError({ status: 400, code: '23514' })).toBe('rejected');
    expect(classifySyncError({ status: 400, code: '22P02' })).toBe('rejected');
    expect(classifySyncError({ status: 500, code: 'XX000' })).toBe('error');
  });

  it('agoParts', () => {
    const now = new Date('2026-11-15T12:00:00Z');
    expect(agoParts('2026-11-15T11:59:30Z', now)).toEqual({ unit: 'now', n: 0 });
    expect(agoParts('2026-11-15T11:58:00Z', now)).toEqual({ unit: 'min', n: 2 });
    expect(agoParts('2026-11-15T09:00:00Z', now)).toEqual({ unit: 'h', n: 3 });
    expect(agoParts('2026-11-13T12:00:00Z', now)).toEqual({ unit: 'd', n: 2 });
  });
});

describe('§6.1.1 scenarios against the in-memory fake of public.sync', () => {
  it.each(SCENARIOS.map((s) => [s.id, s] as const))('%s', (_id, scenario) => {
    const server = new FakeSyncServer();
    const outcomes = runScenario(scenario, server);
    expect(checkScenario(scenario, server, outcomes)).toEqual([]);
  });

  it('99_test.sql asserts every scenario id', () => {
    const sql = require('fs').readFileSync(`${__dirname}/../../../../supabase/tests/99_test.sql`, 'utf8');
    for (const s of SCENARIOS) expect(sql).toContain(`'${s.id}:`);
  });
});

describe('client ↔ fake server round trips', () => {
  /** A device: local state + the exact client steps of syncNow (build → call → apply in one go). */
  class Device {
    local: LocalState = { lists: [], items: [] };
    since: string | null = null;
    private n = 0;
    constructor(private server: FakeSyncServer, private deviceId: string, private uid: string) {}
    add(listId: string, part: string, color: number, delta: number): void {
      const row = this.local.items.find((i) => i.list_id === listId && i.part_id === part && i.color_id === color);
      if (row) row.quantity = Math.max(0, row.quantity + delta);
      else this.local.items.push(item(listId, part, color, Math.max(0, delta)));
    }
    sync(): void {
      const { batch } = buildBatch(this.local, `${this.deviceId.slice(0, 8)}-0000-0000-0000-${String(++this.n).padStart(12, '0')}`);
      const full = needsFullPull(this.since, new Date('2026-11-15T09:00:00Z'));
      const r = this.server.sync(this.uid, { p_device_id: this.deviceId, p_batch_id: batch.batchId,
        p_since: full ? null : this.since, p_lists: batch.lists, p_items: batch.items });
      this.apply(applyResponse(this.local, batch, r, full));
    }
    private apply(plan: ApplyPlan): void {
      const key = (i: { list_id: string; part_id: string; color_id: number }): string => `${i.list_id}|${i.part_id}|${i.color_id}`;
      const lists = new Map(this.local.lists.map((l) => [l.id, l]));
      for (const id of plan.deleteLists) lists.delete(id);
      for (const l of plan.upsertLists) lists.set(l.id, l);
      const items = new Map(this.local.items.filter((i) => !plan.deleteLists.includes(i.list_id)).map((i) => [key(i), i]));
      for (const d of plan.deleteItems) items.delete(`${d.listId}|${d.partId}|${d.colorId}`);
      for (const i of plan.upsertItems) items.set(key(i), i);
      this.local = { lists: [...lists.values()], items: [...items.values()] };
      this.since = plan.since;
    }
    q(listId: string, part: string, color: number): number {
      return this.local.items.find((i) => i.list_id === listId && i.part_id === part && i.color_id === color)?.quantity ?? 0;
    }
  }

  it('offline +3 on A and +2 on B converge to the sum (H2); a replayed state never doubles', () => {
    const server = new FakeSyncServer();
    const a = new Device(server, IDS.A, IDS.U);
    const b = new Device(server, IDS.B, IDS.U);
    a.local.lists.push(list(IDS.L, DEFAULT, { dirty: 1 }));
    a.add(IDS.L, '3001', 4, 1);
    a.sync();
    b.sync();
    expect(b.q(IDS.L, '3001', 4)).toBe(1);
    a.add(IDS.L, '3001', 4, 3);
    b.add(IDS.L, '3001', 4, 2);
    a.sync();
    b.sync();
    a.sync();
    expect(a.q(IDS.L, '3001', 4)).toBe(6);
    expect(b.q(IDS.L, '3001', 4)).toBe(6);
    expect(server.quantity(IDS.L, '3001', 4)).toBe(6);
    a.sync();
    expect(a.q(IDS.L, '3001', 4)).toBe(6);
    expect(pendingCount(a.local).pending).toBe(0);
  });

  it('A removes a reference while B adds 1 offline → both show 1 (H3)', () => {
    const server = new FakeSyncServer();
    const a = new Device(server, IDS.A, IDS.U);
    const b = new Device(server, IDS.B, IDS.U);
    a.local.lists.push(list(IDS.L, DEFAULT, { dirty: 1 }));
    a.add(IDS.L, '3001', 4, 2);
    a.sync();
    b.sync();
    a.add(IDS.L, '3001', 4, -2);
    b.add(IDS.L, '3001', 4, 1);
    a.sync();
    b.sync();
    a.sync();
    expect(a.q(IDS.L, '3001', 4)).toBe(1);
    expect(b.q(IDS.L, '3001', 4)).toBe(1);
  });
});
