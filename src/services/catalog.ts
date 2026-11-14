// Catalogue service (D6, D7, D14, D15, EX_12–EX_15): local SQLite first, then catalog-proxy (§6.2).
// The proxy is called through supabase.functions.invoke('catalog-proxy', { body }) (works for guests: only the
// publishable key is sent). Circuit breaker: after a proxy failure (network, 401, 404, 5xx) the proxy is skipped
// for 5 minutes. Calls to the proxy are serialised (one in flight).
import { FunctionsHttpError } from '@supabase/supabase-js';
import type {
  AppError, BricklinkId, Candidate, CatalogCategory, CatalogColor, CatalogPart, ColorId, Palette, PartColorInfo,
  PartDetail, PartId, Result,
} from '@/domain/types';
import { err, ok, toAppError } from '@/domain/result';
import { buildPalette as buildPaletteImpl, parsePaletteJson } from '@/domain/catalog/palette';
import { provisionalPart } from '@/domain/catalog/partInfo';
import {
  parseDetailResponse, parsePartColorsResponse, parsePartsResponse, parseSetQtyResponse,
} from '@/domain/catalog/wire';
import * as repo from '@/data/catalogRepo';
import { getMeta } from '@/data/meta';
import { notify } from '@/data/dbEvents';
import { renamePart } from '@/data/inventoryRepo';
import { supabase } from './supabase';
import { common } from '@/i18n/fr/common';
import { part as partText } from '@/i18n/fr/part';
import seed from '@/data/seed/palette.json';

const DAY = 86_400_000;
const BREAKER_MS = 5 * 60_000;
const PARTS_CHUNK = 50;
const PENDING_RETRIES = 3;
const PENDING_DELAY_MS = 1500;
const PENDING_RECHECK_MS = 10 * 60_000;
const PART_COLORS_CHUNK = 5;
const PART_COLORS_SESSION_CAP = 25;
const TTL = { blMap: 90, negative: 7, partColor: 30, palette: 30 } as const;
const TIMEOUT = { parts: 20_000, other: 15_000 } as const;

const nowIso = () => new Date().toISOString();
const olderThan = (iso: string | null, days: number) => {
  const t = iso ? Date.parse(iso) : NaN;
  return !Number.isFinite(t) || Date.now() - t > days * DAY;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- proxy
let breakerUntil = 0;
let breakerError: AppError | null = null;
let proxyTail: Promise<unknown> = Promise.resolve();

/** Serialised proxy call. Never rejects. */
function callProxy(body: Record<string, unknown>, timeout: number): Promise<Result<unknown>> {
  const run = proxyTail.then(() => invokeProxy(body, timeout));
  proxyTail = run.catch(() => undefined);
  return run;
}

async function invokeProxy(body: Record<string, unknown>, timeout: number): Promise<Result<unknown>> {
  const client = supabase;
  if (!client) return err('not_configured', common.errors.not_configured);
  if (Date.now() < breakerUntil && breakerError) return { ok: false, error: breakerError };
  try {
    const { data, error } = await client.functions.invoke('catalog-proxy', { body, timeout });
    if (!error) return ok(data as unknown);
    let status: number | undefined;
    if (error instanceof FunctionsHttpError) {
      const ctx = (error as { context?: unknown }).context;
      if (ctx && typeof (ctx as { status?: unknown }).status === 'number') status = (ctx as { status: number }).status;
    }
    const appError = status !== undefined ? toAppError(error, status) : toAppError(error);
    // A FunctionsFetchError (no HTTP status) is a network failure.
    const e: AppError = status === undefined && appError.code === 'unknown'
      ? { code: 'offline', message: common.errors.offline, cause: error }
      : appError;
    if (status === undefined || status === 401 || status === 403 || status === 404 || status >= 500) trip(e);
    return { ok: false, error: e };
  } catch (e) {
    const appError = toAppError(e);
    trip(appError);
    return { ok: false, error: appError };
  }
}

function trip(e: AppError): void {
  breakerUntil = Date.now() + BREAKER_MS;
  breakerError = e;
}

/** Test/diagnostic hook: closes the circuit breaker. */
export function resetCatalogBreaker(): void {
  breakerUntil = 0;
  breakerError = null;
}

// ---------------------------------------------------------------- palette
const seedData = parsePaletteJson(seed);
const seedPalette = buildPaletteImpl(seedData.colors, seedData.categories);
let paletteMemo: Palette | null = null;
let paletteLoad: Promise<Palette> | null = null;
let paletteRefreshing = false;

/** Pure (exported for tests): builds the Palette maps from colours + categories. */
export function buildPalette(colors: readonly CatalogColor[], categories: readonly CatalogCategory[]): Palette {
  return buildPaletteImpl(colors, categories);
}

/** Synchronous access to the memoised palette (null before the first getPalette() settled). */
export function peekPalette(): Palette | null {
  return paletteMemo;
}

/** Never rejects. Memoised. Source: catalog_colors / catalog_categories when non-empty, else the bundled seed.
 *  Triggers a background refresh when meta.palette_fetched_at is missing or older than 30 days. */
export function getPalette(): Promise<Palette> {
  if (paletteMemo) return Promise.resolve(paletteMemo);
  paletteLoad ??= (async () => {
    let palette = seedPalette;
    try {
      const local = await repo.readPalette();
      if (local.colors.length > 0 && local.categories.length > 0) palette = buildPaletteImpl(local.colors, local.categories);
      void maybeRefreshPalette();
    } catch {
      // database not ready: the seed answers, the next call retries the tables
      paletteLoad = null;
      return seedPalette;
    }
    paletteMemo = palette;
    return palette;
  })();
  return paletteLoad;
}

async function maybeRefreshPalette(): Promise<void> {
  if (paletteRefreshing) return;
  paletteRefreshing = true;
  try {
    if (!olderThan(await getMeta('palette_fetched_at'), TTL.palette)) return;
    const r = await callProxy({ op: 'palette' }, TIMEOUT.other);
    if (!r.ok) return;
    const fresh = parsePaletteJson(r.value);
    if (fresh.colors.length < 100 || fresh.categories.length === 0) return; // implausible answer: keep what we have
    const palette = buildPaletteImpl(fresh.colors, fresh.categories);
    await repo.writePalette(palette.colors, palette.categories, nowIso());
    paletteMemo = palette;
    notify('catalog');
  } catch {
    // background refresh: retried at the next app start
  } finally {
    paletteRefreshing = false;
  }
}

// ---------------------------------------------------------------- candidate resolution (D7)
type Cand = Pick<Candidate, 'bricklinkId' | 'name' | 'imageUrl'>;

/** D7. Never rejects; every input id has an entry in the result. */
export async function resolveCandidates(candidates: readonly Cand[]): Promise<Map<BricklinkId, CatalogPart>> {
  const byId = new Map<BricklinkId, Cand>();
  for (const c of candidates) if (!byId.has(c.bricklinkId)) byId.set(c.bricklinkId, c);
  const out = new Map<BricklinkId, CatalogPart>();
  const notFound = new Set<BricklinkId>();
  let changed = false;
  try {
    // 1. Local BrickLink map.
    const ids = [...byId.keys()];
    const maps = await repo.getBlMap(ids);
    const mappedParts = await repo.getPartRows([...maps.values()].flatMap((m) => (m.partId ? [m.partId] : [])));
    for (const id of ids) {
      const m = maps.get(id);
      if (!m) continue;
      if (m.partId === null) {
        if (!olderThan(m.fetchedAt, TTL.negative)) notFound.add(id);
      } else if (!olderThan(m.fetchedAt, TTL.blMap)) {
        const row = mappedParts.get(m.partId);
        if (row && row.part.source === 'rebrickable') out.set(id, row.part);
      }
    }

    // 2. Proxy for the rest, chunks of 50, 'pending' ids re-requested up to 3 more times.
    let missing = ids.filter((id) => !out.has(id) && !notFound.has(id));
    const found: { bricklinkId: string; part: CatalogPart }[] = [];
    const newNotFound: string[] = [];
    for (let attempt = 0; missing.length > 0 && attempt <= PENDING_RETRIES; attempt++) {
      if (attempt > 0) await sleep(PENDING_DELAY_MS);
      const stillPending: string[] = [];
      let failed = false;
      for (let i = 0; i < missing.length; i += PARTS_CHUNK) {
        const slice = missing.slice(i, i + PARTS_CHUNK);
        const r = failed ? null : await callProxy({ op: 'parts', id_type: 'bricklink', ids: slice }, TIMEOUT.parts);
        const parsed = r && r.ok ? parsePartsResponse(r.value) : null;
        if (!parsed) {
          failed = true;
          continue;
        }
        for (const id of slice) {
          const s = parsed.get(id);
          if (s?.status === 'found') {
            out.set(id, s.part);
            found.push({ bricklinkId: id, part: s.part });
          } else if (s?.status === 'not_found') {
            notFound.add(id);
            newNotFound.push(id);
          } else stillPending.push(id);
        }
      }
      if (failed) break; // proxy unavailable: the rest stays 'pending'
      missing = stillPending;
    }
    // Stale-if-error: an expired local mapping beats a provisional part.
    for (const id of missing) {
      const m = maps.get(id);
      const row = m?.partId ? mappedParts.get(m.partId) : undefined;
      if (!out.has(id) && !notFound.has(id) && row && row.part.source === 'rebrickable') out.set(id, row.part);
    }
    if (found.length > 0 || newNotFound.length > 0) {
      await repo.saveBricklinkResolutions(found, newNotFound, nowIso());
      changed = true;
    }
  } catch {
    // local cache unavailable: fall through to provisional parts
  }

  // 3. Provisional parts for everything unresolved.
  const provisional: CatalogPart[] = [];
  for (const [id, c] of byId) {
    if (out.has(id)) continue;
    const p = provisionalPart(c, notFound.has(id) ? 'not_found' : 'pending');
    out.set(id, p);
    provisional.push(p);
  }
  try {
    if (await repo.saveProvisionalParts(provisional, nowIso())) changed = true;
  } catch {
    // provisional parts are still returned
  }
  if (changed) notify('catalog');
  return out;
}

/** Local only. */
export async function getPart(partId: PartId): Promise<CatalogPart | null> {
  try {
    return await repo.getPartRow(partId);
  } catch {
    return null;
  }
}

/** Local catalog_part_colors row, any age (identity block of the fiche when the proxy is unreachable). */
export async function getLocalPartColor(partId: PartId, colorId: ColorId): Promise<PartColorInfo | null> {
  try {
    return (await repo.getPartColor(partId, colorId))?.info ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- hydration
let hydrating: Promise<void> | null = null;
const hydrateQueue = new Set<PartId>();
const pendingAttempt = new Map<PartId, number>();
const partColorsAsked = new Set<PartId>();

/** Never rejects; serialised with the other proxy calls; at most one run in flight (ids passed while a run is in
 *  flight are processed by that same run, before its promise resolves). */
export function hydrateParts(partIds: readonly PartId[]): Promise<void> {
  for (const id of partIds) hydrateQueue.add(id);
  hydrating ??= (async () => {
    try {
      while (hydrateQueue.size > 0) {
        const batch = [...hydrateQueue];
        hydrateQueue.clear();
        try {
          await hydrateOnce(batch);
        } catch {
          // never rejects; next load retries
        }
      }
    } finally {
      hydrating = null;
    }
  })();
  return hydrating;
}

async function hydrateOnce(partIds: readonly PartId[]): Promise<void> {
  if (partIds.length === 0) return;
  let changed = false;
  const stamp = nowIso();
  const rows = await repo.getPartRows(partIds);

  // a) Unknown ids, or not_found rows whose 7-day negative cache expired → by Rebrickable id.
  const toLookup = partIds.filter((id) => {
    const r = rows.get(id);
    return !r || (r.part.resolution === 'not_found' && olderThan(r.fetchedAt, TTL.negative));
  });
  for (let i = 0; i < toLookup.length; i += PARTS_CHUNK) {
    const slice = toLookup.slice(i, i + PARTS_CHUNK);
    const r = await callProxy({ op: 'parts', id_type: 'rebrickable', ids: slice }, TIMEOUT.parts);
    const parsed = r.ok ? parsePartsResponse(r.value) : null;
    if (!parsed) break;
    const resolved: CatalogPart[] = [];
    const missing: PartId[] = [];
    for (const id of slice) {
      const s = parsed.get(id);
      if (s?.status === 'found' && s.part.partId === id) resolved.push(s.part);
      else if (s?.status === 'not_found') missing.push(id);
    }
    await repo.saveParts(resolved, stamp);
    await repo.markRebrickableNotFound(missing, stamp);
    if (resolved.length > 0 || missing.length > 0) changed = true;
  }

  // b) Pending provisional parts → re-resolved by BrickLink id (at most once per 10 minutes per part).
  const now = Date.now();
  const pending = partIds.filter((id) => {
    const r = rows.get(id);
    if (!r || r.part.resolution !== 'pending') return false;
    const last = pendingAttempt.get(id);
    return last === undefined || now - last >= PENDING_RECHECK_MS;
  });
  for (let i = 0; i < pending.length; i += PARTS_CHUNK) {
    const slice = pending.slice(i, i + PARTS_CHUNK);
    for (const id of slice) pendingAttempt.set(id, now);
    const r = await callProxy({ op: 'parts', id_type: 'bricklink', ids: slice }, TIMEOUT.parts);
    const parsed = r.ok ? parsePartsResponse(r.value) : null;
    if (!parsed) break;
    const notFound: string[] = [];
    for (const oldId of slice) {
      const s = parsed.get(oldId);
      if (s?.status === 'found') {
        if (s.part.partId !== oldId) await renamePart(oldId, s.part.partId);
        await repo.replaceProvisional(oldId, s.part, stamp);
        changed = true;
      } else if (s?.status === 'not_found') notFound.push(oldId);
    }
    if (notFound.length > 0) {
      const provisional = notFound.map((id) => ({ ...rows.get(id)!.part, resolution: 'not_found' as const }));
      await repo.saveBricklinkResolutions([], notFound, stamp);
      await repo.saveProvisionalParts(provisional, stamp);
      changed = true;
    }
  }

  // c) Coloured tile images: resolved parts whose inventory colour has no catalog_part_colors row.
  const wanted = await repo.missingPartColors(partIds);
  const partsToAsk: PartId[] = [];
  for (const { partId } of wanted) {
    if (partsToAsk.includes(partId) || partColorsAsked.has(partId)) continue;
    if (partColorsAsked.size + partsToAsk.length >= PART_COLORS_SESSION_CAP) break;
    partsToAsk.push(partId);
  }
  for (let i = 0; i < partsToAsk.length; i += PART_COLORS_CHUNK) {
    const slice = partsToAsk.slice(i, i + PART_COLORS_CHUNK);
    for (const id of slice) partColorsAsked.add(id);
    const r = await callProxy({ op: 'part_colors', part_ids: slice }, TIMEOUT.other);
    const parsed = r.ok ? parsePartColorsResponse(r.value) : null;
    if (!parsed) break;
    const toSave: PartColorInfo[] = [];
    for (const partId of slice) {
      const colors = parsed.get(partId);
      if (!colors) continue;
      for (const c of colors) {
        toSave.push({ partId, colorId: c.colorId, found: true, elementIds: c.elementIds, imageUrl: c.imageUrl, numSets: c.numSets });
      }
      // Inventory colours Rebrickable does not list for this part: found = false (no re-ask every load).
      for (const w of wanted) {
        if (w.partId === partId && !colors.some((c) => c.colorId === w.colorId)) {
          toSave.push({ partId, colorId: w.colorId, found: false, elementIds: [], imageUrl: null, numSets: 0 });
        }
      }
    }
    await repo.savePartColors(toSave, stamp);
    if (toSave.length > 0) changed = true;
  }

  if (changed) notify('catalog');
}

// ---------------------------------------------------------------- fiche pièce
/** EX_12 / EX_14. Local catalog_part_colors younger than 30 days answers `partColor` without network; sets pages
 *  always come from the proxy (cached server-side). Provisional part → err('not_found'). Never rejects. */
export async function getPartDetail(partId: PartId, colorId: ColorId, page = 1): Promise<Result<PartDetail>> {
  try {
    const part = await getPart(partId);
    if (part && part.source === 'brickognize') return err('not_found', partText.provisionalNoSets);
    let local: Awaited<ReturnType<typeof repo.getPartColor>> = null;
    try {
      local = await repo.getPartColor(partId, colorId);
    } catch {
      local = null;
    }
    const freshLocal = local && !olderThan(local.fetchedAt, TTL.partColor) ? local.info : null;
    if (freshLocal && !freshLocal.found) return ok({ partColor: freshLocal, sets: null, stale: false });

    const r = await callProxy({ op: 'detail', part_id: partId, color_id: colorId, page }, TIMEOUT.other);
    if (!r.ok) return r;
    const detail = parseDetailResponse(r.value, partId, colorId);
    if (!detail) return err('server', common.errors.server);
    if (freshLocal) return ok({ ...detail, partColor: freshLocal });
    try {
      await repo.savePartColors([detail.partColor], nowIso());
      notify('catalog');
    } catch {
      // cache write is best effort
    }
    return ok(detail);
  } catch (e) {
    return { ok: false, error: toAppError(e) };
  }
}

/** D15. Quantity of the part+colour in one set (spares excluded); null when the set does not list it. */
export async function getSetQuantity(setNum: string, partId: PartId, colorId: ColorId): Promise<Result<number | null>> {
  try {
    const r = await callProxy({ op: 'set_qty', set_num: setNum, part_id: partId, color_id: colorId }, TIMEOUT.other);
    if (!r.ok) return r;
    const q = parseSetQtyResponse(r.value);
    return q === undefined ? err('server', common.errors.server) : ok(q);
  } catch (e) {
    return { ok: false, error: toAppError(e) };
  }
}
