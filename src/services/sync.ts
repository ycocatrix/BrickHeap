// Offline-first sync service (§4.10, D11, RG_08/11/12): quantity deltas through the idempotent `public.sync` RPC.
// No realtime, no polling. Triggers: foreground, 2 s after a local mutation, manual, login.
// Every SQLite write happens inside ONE withWrite callback per step (read + apply + write), never across awaits.
import { AppState } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import type { AppError, Result, SyncBatch, SyncResponse, SyncStatus } from '@/domain/types';
import { ok, toAppError } from '@/domain/result';
import {
  applyResponse, buildBatch, classifySyncError, isEmptyBatch, isResponseCurrent, needsFullPull, planFirstSync,
  remapGuestItems, type RpcErrorLike,
} from '@/domain/sync/sync';
import { db, withWrite } from '@/data/db';
import { notify, subscribe as subscribeDb } from '@/data/dbEvents';
import { getDeviceId, getMeta, setMeta } from '@/data/meta';
import {
  applyGuestRemap, deleteAllUserRows, detachAsGuest, heldPartIds, readLocalState, readPendingCounts, writePlan,
} from '@/data/syncRepo';
import { DEFAULT_LIST_NAME } from '@/data/inventoryRepo';
import { hydrateParts } from '@/services/catalog';
import { supabase } from '@/services/supabase';
import { sessionStore } from '@/state/session';
import { createStore, useStore, type Store } from '@/state/createStore';
import { common } from '@/i18n/fr/common';
import { plural, tpl } from '@/i18n/format';
import { sync as t } from '@/i18n/fr/sync';

export const syncStore: Store<SyncStatus> = createStore<SyncStatus>({
  state: 'disabled',
  lastSyncAt: null,
  pending: 0,
  awaitingCatalog: 0,
  error: null,
});

/** Extra data for the RG_11 prompt (not part of SyncStatus): number of local references to merge. */
export const mergePromptStore: Store<{ localRefs: number }> = createStore({ localRefs: 0 });

const selectAll = (s: SyncStatus): SyncStatus => s;
/** Stable reference from the store. */
export function useSyncStatus(): SyncStatus {
  return useStore(syncStore, selectAll);
}

type Reason = 'foreground' | 'mutation' | 'manual' | 'login';
const MUTATION_DEBOUNCE_MS = 2000;
const MIN_INTERVAL_MS = 30000;
const MAX_ROUNDS = 10;

// ---------- module state ----------
/** Bumped by wipeLocalUserData / keepLocalAsGuest: any response captured before is discarded (step 5 guard). */
let generation = 0;
let inflight: Promise<Result<void>> | null = null;
let rerun: Reason | null = null;
let controller: AbortController | null = null;
let lastSyncMs = 0;
/** Probe kept while the RG_11 prompt is open. */
let pendingProbe: { uid: string; probe: SyncResponse; generation: number } | null = null;
/** User whose local data was just wiped / detached (sign-out, keep-as-guest): no first sync may re-attach the
 *  device to them before the session user changes (a debounced or foreground trigger could otherwise land between
 *  wipeLocalUserData() and supabase.auth.signOut()). Cleared when the user changes, or by 'replace'. */
let blockedUid: string | null = null;

const setStatus = (patch: Partial<SyncStatus>): void => syncStore.set(patch);
const currentUserId = (): string | null => sessionStore.get().user?.id ?? null;
const nowIso = (): string => new Date().toISOString();

async function refreshPending(): Promise<void> {
  try {
    setStatus(await readPendingCounts(db()));
  } catch {
    // db not open yet: counts stay as they are
  }
}

function startHydration(partIds: string[]): void {
  if (partIds.length === 0) return;
  try {
    void hydrateParts(partIds).catch(() => undefined);   // D7: never awaited, the resolved rows sync later
  } catch {
    // catalogue unavailable: the held items simply wait
  }
}

/** State when no user is signed in (RG_12): local data still owned by an account → needs_login, else guest. */
async function stateWithoutUser(): Promise<void> {
  const owner = await getMeta('owner_uid').catch(() => null);
  pendingProbe = null;
  setStatus({ state: owner ? 'needs_login' : 'disabled', error: null });
}

// ---------- RPC ----------
type RpcOutcome = { ok: true; response: SyncResponse } | { ok: false; kind: 'offline' | 'needs_login' | 'rejected' | 'error' | 'aborted'; error: AppError };

function syncError(kind: 'offline' | 'needs_login' | 'rejected' | 'error', cause: unknown): AppError {
  if (kind === 'offline') return { code: 'offline', message: common.errors.offline, cause };
  if (kind === 'needs_login') return { code: 'unauthorized', message: common.errors.unauthorized, cause };
  if (kind === 'rejected') return { code: 'invalid', message: t.errors.rejected, cause };
  return { code: 'server', message: common.errors.server, cause };
}

function isSyncResponse(v: unknown): v is SyncResponse {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.server_time === 'string' && Array.isArray(o.lists) && Array.isArray(o.items);
}

async function callSync(batch: SyncBatch, since: string | null, signal: AbortSignal): Promise<RpcOutcome> {
  const client = supabase;
  if (!client) return { ok: false, kind: 'error', error: { code: 'not_configured', message: common.errors.not_configured } };
  // auth-js refreshes an expired token here; offline that fails with a retryable error → 'offline', never
  // 'needs_login' (RG_12: an offline cold start with an expired token is not an expired session).
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (signal.aborted) return { ok: false, kind: 'aborted', error: syncError('offline', null) };
  if (!sessionData.session) {
    if (!sessionError || isAuthRetryableFetchError(sessionError)) {
      return { ok: false, kind: 'offline', error: syncError('offline', sessionError) };
    }
    return { ok: false, kind: 'needs_login', error: syncError('needs_login', sessionError) };
  }
  const deviceId = await getDeviceId();
  const res = await client
    .rpc('sync', {
      p_device_id: deviceId,
      p_batch_id: batch.batchId,
      p_since: since,
      p_lists: batch.lists,
      p_items: batch.items,
    })
    .abortSignal(signal);
  if (signal.aborted) return { ok: false, kind: 'aborted', error: syncError('offline', res.error) };
  if (res.error) {
    const e: RpcErrorLike = { status: res.status, code: res.error.code, message: res.error.message };
    const kind = classifySyncError(e);
    return { ok: false, kind, error: syncError(kind, res.error) };
  }
  if (!isSyncResponse(res.data)) return { ok: false, kind: 'error', error: syncError('error', res.data) };
  return { ok: true, response: res.data };
}

/** Applies an RPC failure to the status. 'rejected' discards the pending batch (the server rolled it back; the
 *  next batch is rebuilt from quantity − base_quantity, so nothing can be applied twice). */
async function handleFailure(out: Exclude<RpcOutcome, { ok: true }>): Promise<Result<void>> {
  if (out.kind === 'aborted') return ok(undefined);
  if (out.kind === 'rejected') await setMeta('pending_batch', null).catch(() => undefined);
  const state = out.kind === 'offline' ? 'offline' : out.kind === 'needs_login' ? 'needs_login' : 'error';
  setStatus({ state, error: out.error });
  return { ok: false, error: out.error };
}

// ---------- ordinary sync rounds (owner_uid === user.id) ----------
function parseBatch(raw: string | null): SyncBatch | null {
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as SyncBatch;
    return typeof b.batchId === 'string' && Array.isArray(b.lists) && Array.isArray(b.items) ? b : null;
  } catch {
    return null;
  }
}

async function syncRounds(uid: string): Promise<Result<void>> {
  let invalidCount = 0;
  let hydrated = false;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const captured = { uid, generation };
    const ac = new AbortController();
    controller = ac;
    setStatus({ state: 'syncing' });

    // Step 3: resend the pending batch unchanged, else build and persist a new one BEFORE the call.
    let batch = parseBatch(await getMeta('pending_batch'));
    if (!batch) {
      const built = await withWrite(async (tx) => {
        const local = await readLocalState(tx);
        const b = buildBatch(local, randomUUID());
        if (!isEmptyBatch(b.batch)) await setMeta('pending_batch', JSON.stringify(b.batch), tx);
        return { ...b, held: heldPartIds(local) };
      });
      batch = built.batch;
      invalidCount = built.invalid.lists.length + built.invalid.items.length;
      if (!hydrated) {
        startHydration(built.held);                       // step 2
        hydrated = true;
      }
    }
    if (captured.generation !== generation) return ok(undefined);

    // Step 4.
    const since = await getMeta('since');
    const fullPull = needsFullPull(since, new Date());
    const out = await callSync(batch, fullPull ? null : since, ac.signal);
    if (controller === ac) controller = null;
    if (!out.ok) return handleFailure(out);

    // Step 5: one callback — guard, read, apply, write, meta.
    const sent = batch;
    const result = await withWrite(async (tx) => {
      const owner = await getMeta('owner_uid', tx);
      if (!isResponseCurrent(captured, { ownerUid: owner, generation })) return null;
      const local = await readLocalState(tx);
      const plan = applyResponse(local, sent, out.response, fullPull);
      await writePlan(tx, plan, nowIso());
      await setMeta('since', plan.since, tx);
      await setMeta('pending_batch', null, tx);
      const after = await readLocalState(tx);
      return { more: !isEmptyBatch(buildBatch(after, 'probe').batch) };
    });
    if (!result) return ok(undefined);                    // discarded: wiped / other owner meanwhile
    notify('inventory', 'lists');                         // never 'mutation'
    lastSyncMs = Date.now();
    setStatus({ lastSyncAt: nowIso() });
    if (!result.more) break;                              // step 6
  }
  await refreshPending();
  setStatus({
    state: 'idle',
    error: invalidCount > 0
      ? { code: 'invalid', message: tpl(plural(invalidCount, t.errors.invalidOne, t.errors.invalidOther), { n: invalidCount }) }
      : null,
  });
  return ok(undefined);
}

// ---------- first sync of this device for an account (owner_uid null) ----------
/** Writes the « Fusionner » or « Garder uniquement mon compte » outcome in one callback; false when stale. */
async function applyFirstSync(uid: string, probe: SyncResponse, gen: number, mode: 'merge' | 'keep_account'): Promise<boolean> {
  const done = await withWrite(async (tx) => {
    const owner = await getMeta('owner_uid', tx);
    if (owner !== null || gen !== generation || currentUserId() !== uid) return false;
    const local = await readLocalState(tx);
    if (mode === 'merge') {
      const live = new Set(local.lists.filter((l) => l.deleted === 0).map((l) => l.id));
      const { listIdMap } = planFirstSync(local, probe, DEFAULT_LIST_NAME);
      const remapped = remapGuestItems(local.items.filter((i) => live.has(i.list_id) && i.quantity > 0), listIdMap);
      await applyGuestRemap(tx, listIdMap, remapped, nowIso());
    } else {
      await deleteAllUserRows(tx);
    }
    await setMeta('owner_uid', uid, tx);
    await setMeta('pending_batch', null, tx);
    const fresh = await readLocalState(tx);
    const plan = applyResponse(fresh, { batchId: '', lists: [], items: [] }, probe, true);
    await writePlan(tx, plan, nowIso());
    await setMeta('since', plan.since, tx);
    return true;
  });
  if (done) notify('inventory', 'lists');
  return done;
}

async function firstSync(uid: string): Promise<Result<void>> {
  const gen = generation;
  const ac = new AbortController();
  controller = ac;
  setStatus({ state: 'syncing' });
  // Probe: empty arrays, p_since null (read-only apart from the device row).
  const out = await callSync({ batchId: randomUUID(), lists: [], items: [] }, null, ac.signal);
  if (controller === ac) controller = null;
  if (!out.ok) return handleFailure(out);
  if (gen !== generation || currentUserId() !== uid) return ok(undefined);
  const local = await readLocalState(db());
  const plan = planFirstSync(local, out.response, DEFAULT_LIST_NAME);
  if (plan.prompt) {
    pendingProbe = { uid, probe: out.response, generation: gen };
    mergePromptStore.set({ localRefs: plan.localRefs });
    setStatus({ state: 'merge_pending', error: null });
    return ok(undefined);
  }
  if (!(await applyFirstSync(uid, out.response, gen, 'merge'))) return ok(undefined);
  return syncRounds(uid);
}

// ---------- single flight ----------
async function run(reason: Reason): Promise<Result<void>> {
  try {
    if (!supabase) {
      setStatus({ state: 'disabled', error: null });
      return ok(undefined);
    }
    const uid = currentUserId();
    if (!uid) {
      await stateWithoutUser();
      return ok(undefined);
    }
    const state = syncStore.get().state;
    if (state === 'merge_pending' || state === 'account_mismatch' || uid === blockedUid) return ok(undefined);
    const owner = await getMeta('owner_uid');
    if (owner === null) return await firstSync(uid);
    if (owner !== uid) {
      setStatus({ state: 'account_mismatch', error: null });
      return ok(undefined);
    }
    if (reason !== 'manual' && reason !== 'login') {
      await refreshPending();
      const s = syncStore.get();
      const nothingToPush = s.pending - s.awaitingCatalog === 0 && !(await getMeta('pending_batch'));
      if (nothingToPush && Date.now() - lastSyncMs < MIN_INTERVAL_MS && s.state === 'idle') return ok(undefined);
    }
    return await syncRounds(uid);
  } catch (e) {
    const error = toAppError(e);
    setStatus({ state: error.code === 'offline' || error.code === 'timeout' ? 'offline' : 'error', error });
    return { ok: false, error };
  } finally {
    controller = null;
    // A discarded response (wipe / owner change meanwhile) must not leave the line on « Synchronisation… ».
    if (syncStore.get().state === 'syncing') setStatus({ state: 'idle' });
  }
}

/** Single-flight, never rejects. ok(void) and no request when guest, not configured, merge_pending,
 *  account_mismatch, or nothing to push and last sync < 30 s ago (unless reason 'manual' / 'login').
 *  A 'manual' / 'login' call made while a sync runs schedules one more run right after it. */
export function syncNow(reason: Reason = 'manual'): Promise<Result<void>> {
  if (inflight) {
    if (reason === 'manual' || reason === 'login') rerun = reason;
    return inflight;
  }
  const p = run(reason).finally(() => {
    if (inflight === p) inflight = null;
    const next = rerun;
    rerun = null;
    if (next) void syncNow(next);
  });
  inflight = p;
  return p;
}

/** Aborts the in-flight request and waits for the single-flight promise to settle. */
async function stopInflight(): Promise<void> {
  rerun = null;
  controller?.abort();
  if (inflight) await inflight.catch(() => undefined);
}

// ---------- lifecycle ----------
let stopFn: (() => void) | null = null;

/** Idempotent. Registers: AppState 'active' → syncNow('foreground'); dbEvents 'mutation' → recompute
 *  pending / awaitingCatalog immediately and syncNow('mutation') after a 2 s debounce; sessionStore user changes →
 *  sign-in procedure / state update. Returns the unsubscribe function. */
export function startSync(): () => void {
  if (stopFn) return () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastUser = sessionStore.get().user;

  const appSub = AppState.addEventListener('change', (s) => {
    if (s === 'active') void syncNow('foreground');
  });
  const offMutation = subscribeDb('mutation', () => {
    void refreshPending();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void syncNow('mutation');
    }, MUTATION_DEBOUNCE_MS);
  });
  const offSession = sessionStore.subscribe(() => {
    const user = sessionStore.get().user;
    if (user === lastUser) return;
    const switched = (lastUser?.id ?? null) !== (user?.id ?? null);
    lastUser = user;
    if (switched) blockedUid = null;
    if (!user) {
      // SIGNED_OUT (explicit sign-out clears owner_uid first → disabled; auth-js sign-out → needs_login).
      controller?.abort();
      void stateWithoutUser();
      return;
    }
    if (switched && (syncStore.get().state === 'merge_pending' || syncStore.get().state === 'account_mismatch')) {
      pendingProbe = null;
      setStatus({ state: 'idle' });
    }
    void syncNow('login');                                // SIGNED_IN / TOKEN_REFRESHED / USER_UPDATED
  });

  void refreshPending();
  if (!supabase) setStatus({ state: 'disabled' });
  else if (lastUser) void syncNow('login');
  else void stateWithoutUser();

  const stop = (): void => {
    appSub.remove();
    offMutation();
    offSession();
    if (timer) clearTimeout(timer);
    timer = null;
    stopFn = null;
  };
  stopFn = stop;
  return stop;
}

// ---------- prompts (GuestMergeHost) ----------
/** Answer to the guest-merge prompt (state 'merge_pending'): 'merge' applies the name mapping + the probe as a
 *  full pull, then the ordinary push adds the local quantities (RG_11); 'keep_account' (confirmed twice in the UI)
 *  deletes local lists/items and applies the probe; 'cancel' signs out locally, local data untouched, guest. */
export async function resolveGuestMerge(choice: 'merge' | 'keep_account' | 'cancel'): Promise<void> {
  const pending = pendingProbe;
  if (syncStore.get().state !== 'merge_pending' || !pending) return;
  await stopInflight();
  if (choice === 'cancel') {
    pendingProbe = null;
    setStatus({ state: 'disabled', error: null });
    try {
      await supabase?.auth.signOut({ scope: 'local' });
    } catch {
      // the SIGNED_OUT event may not come; the state is already guest
    }
    return;
  }
  try {
    // false = stale probe (owner set / wiped / other user meanwhile): the next sync starts over with a new probe.
    await applyFirstSync(pending.uid, pending.probe, pending.generation, choice);
    pendingProbe = null;
    setStatus({ state: 'idle', error: null });
    await syncNow('login');
  } catch (e) {
    setStatus({ state: 'merge_pending', error: { code: 'unknown', message: t.merge.failed, cause: e } });
  }
}

/** Answer to state 'account_mismatch' (signed in as B, local data owned by A): 'replace' → wipe, then the
 *  first-sync procedure for B; 'keep_as_guest' → keepLocalAsGuest() then local sign-out; 'cancel' → local
 *  sign-out (data stays owned by A → needs_login). */
export async function resolveAccountMismatch(choice: 'replace' | 'keep_as_guest' | 'cancel'): Promise<void> {
  if (syncStore.get().state !== 'account_mismatch') return;
  if (choice === 'replace') {
    await wipeLocalUserData();
    blockedUid = null;                                    // first sync for B wanted right now
    setStatus({ state: 'idle', error: null });
    await syncNow('login');
    return;
  }
  if (choice === 'keep_as_guest') await keepLocalAsGuest();
  else setStatus({ state: 'needs_login', error: null });
  try {
    await supabase?.auth.signOut({ scope: 'local' });
  } catch {
    // ignored: local sign-out only clears the stored session
  }
}

// ---------- detaching / wiping local data ----------
/** RG_12 dead-end exit: detaches local data from the account. Inside one withWrite: owner_uid, since and
 *  pending_batch cleared, base_quantity = 0 on every item, rows with quantity 0 deleted, tombstoned lists
 *  deleted, live lists dirty = 1; bumps the generation; state 'disabled' (guest). */
export async function keepLocalAsGuest(): Promise<void> {
  blockedUid = currentUserId();
  generation++;
  await stopInflight();
  generation++;
  await withWrite(async (tx) => {
    await detachAsGuest(tx);
    await setMeta('owner_uid', null, tx);
    await setMeta('since', null, tx);
    await setMeta('pending_batch', null, tx);
  });
  pendingProbe = null;
  notify('inventory', 'lists');
  setStatus({ state: 'disabled', error: null, lastSyncAt: null });
  await refreshPending();
}

/** Aborts the in-flight request, awaits the single-flight promise, bumps the generation, then inside one
 *  withWrite deletes lists, items and the meta keys owner_uid / since / pending_batch / last_list_id (keeps
 *  device_id and the catalogue cache); notify('inventory', 'lists'). */
export async function wipeLocalUserData(): Promise<void> {
  blockedUid = currentUserId();
  generation++;                                           // also before: a response landing now is discarded
  await stopInflight();
  generation++;
  await withWrite(async (tx) => {
    await deleteAllUserRows(tx);
    await setMeta('owner_uid', null, tx);
    await setMeta('since', null, tx);
    await setMeta('pending_batch', null, tx);
    await setMeta('last_list_id', null, tx);
  });
  pendingProbe = null;
  lastSyncMs = 0;
  notify('inventory', 'lists');
  setStatus({ state: 'disabled', error: null, lastSyncAt: null, pending: 0, awaitingCatalog: 0 });
}
