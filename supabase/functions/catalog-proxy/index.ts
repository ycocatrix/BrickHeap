// catalog-proxy (§6.2, D14): Rebrickable behind a Postgres cache-aside, for guests and signed-in users alike.
// verify_jwt = false; the wrapper validates the publishable key (`apikey` header) and handles CORS.
// Database access through ctx.supabaseAdmin only. Never logs request bodies or the Rebrickable key.
import "@supabase/functions-js/edge-runtime.d.ts";
import { type SupabaseContext, withSupabase } from "@supabase/server";
import { rb, rbNext } from "../_shared/rebrickable.ts";
import {
  acceptsBricklinkId, chunk, isFresh, notFoundRow, pickPrimary, type PartRow, type RbPart, SET_NUM_RE,
  suffixProbeIds, sumSetQuantity, toPartRow, toWireColor, toWirePart, TTL_DAYS, validateId, validateIds,
  validateInt, type WirePart,
} from "../_shared/mapping.ts";

type Db = SupabaseContext["supabaseAdmin"];
// deno-lint-ignore no-explicit-any
type Json = any;
type PartStatus = { status: "found"; part: WirePart } | { status: "not_found" } | { status: "pending" };

const json = (body: unknown, status = 200) => Response.json(body, { status });
const badRequest = (field: string) => json({ error: "bad_request", field }, 400);
const upstreamFailed = () => json({ error: "upstream" }, 502);
const nowIso = () => new Date().toISOString();
const FALLBACK_PER_REQUEST = 5;

/** Best-effort cache read: a database error is a cache miss. */
async function select<T>(q: PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  try {
    const { data, error } = await q;
    return error || !data ? [] : data;
  } catch {
    return [];
  }
}
/** Best-effort cache write. */
async function write(q: PromiseLike<{ error: unknown }>): Promise<void> {
  try {
    await q;
  } catch {
    // the answer does not depend on the cache write
  }
}

// ---------------------------------------------------------------- parts
type PartsCacheRow = PartRow;
interface BlMapRow { bricklink_id: string; part_ids: string[]; fetched_at: string }

async function readParts(db: Db, ids: string[]): Promise<Map<string, PartsCacheRow>> {
  if (ids.length === 0) return new Map();
  const rows = await select<PartsCacheRow>(db.from("parts_cache").select("*").in("part_id", ids));
  return new Map(rows.map((r) => [r.part_id, r]));
}

async function partsByNums(nums: string[]): Promise<RbPart[]> {
  const out: RbPart[] = [];
  for (const c of chunk(nums, 100)) {
    const page = await rb(`/parts/?part_nums=${c.map(encodeURIComponent).join(",")}&inc_part_details=1&page_size=100`);
    out.push(...((page?.results ?? []) as RbPart[]));
  }
  return out;
}

async function partsBricklink(db: Db, ids: string[]): Promise<Response> {
  const now = Date.now();
  const result: Record<string, PartStatus> = {};
  let stale = false;

  // 1. BrickLink map cache.
  const maps = await select<BlMapRow>(db.from("bricklink_map_cache").select("*").in("bricklink_id", ids));
  const mapById = new Map(maps.map((m) => [m.bricklink_id, m]));
  const cachedParts = await readParts(db, [...new Set(maps.flatMap((m) => m.part_ids.slice(0, 1)))]);
  const fromCache = (id: string, anyAge: boolean): PartStatus | null => {
    const m = mapById.get(id);
    if (!m) return null;
    if (m.part_ids.length === 0) {
      return anyAge || isFresh(m.fetched_at, TTL_DAYS.negative, now) ? { status: "not_found" } : null;
    }
    if (!anyAge && !isFresh(m.fetched_at, TTL_DAYS.parts, now)) return null;
    const row = cachedParts.get(m.part_ids[0]);
    return row && row.found ? { status: "found", part: toWirePart(row) } : null;
  };
  for (const id of ids) {
    const hit = fromCache(id, false);
    if (hit) result[id] = hit;
  }

  const missing = ids.filter((id) => !result[id]);
  const newParts = new Map<string, PartRow>();
  const newMaps: BlMapRow[] = [];
  const stamp = nowIso();
  const resolve = (id: string, primary: RbPart, alternates: string[]) => {
    const row = toPartRow(primary, stamp);
    newParts.set(row.part_id, row);
    newMaps.push({ bricklink_id: id, part_ids: [row.part_id, ...alternates.filter((a) => a !== row.part_id)], fetched_at: stamp });
    result[id] = { status: "found", part: toWirePart(row) };
  };
  const negative = (id: string) => {
    newMaps.push({ bricklink_id: id, part_ids: [], fetched_at: stamp });
    result[id] = { status: "not_found" };
  };

  if (missing.length > 0) {
    try {
      // 2. One batched part_nums call.
      const step2 = new Map((await partsByNums(missing)).map((p) => [p.part_num, p]));
      const unresolved: string[] = [];
      for (const id of missing) {
        const p = step2.get(id);
        if (p && acceptsBricklinkId(p, id)) resolve(id, p, []);
        else unresolved.push(id);
      }
      // 3. Per-id BrickLink fallback, at most 5 per request; the rest is 'pending'.
      const probe: string[] = [];
      for (const [i, id] of unresolved.entries()) {
        if (i >= FALLBACK_PER_REQUEST) {
          result[id] = { status: "pending" };
          continue;
        }
        const page = await rb(`/parts/?bricklink_id=${encodeURIComponent(id)}&inc_part_details=1&page_size=20`);
        const picked = pickPrimary(id, (page?.results ?? []) as RbPart[]);
        if (picked) resolve(id, picked.primary, picked.alternates);
        else if (step2.has(id)) resolve(id, step2.get(id)!, []);
        else probe.push(id);
      }
      // 3b. Mould letter stripped by Brickognize: one batched suffix probe.
      const probeNums = probe.flatMap(suffixProbeIds);
      const hits = probeNums.length > 0 ? await partsByNums(probeNums) : [];
      for (const id of probe) {
        const mine = hits.filter((h) => suffixProbeIds(id).includes(h.part_num) && acceptsBricklinkId(h, id));
        const picked = pickPrimary(id, mine);
        if (picked) resolve(id, picked.primary, picked.alternates);
        else negative(id);
      }
    } catch {
      // Stale-if-error: whatever the cache holds, else 'pending'.
      stale = true;
      for (const id of missing) {
        if (result[id]) continue;
        result[id] = fromCache(id, true) ?? { status: "pending" };
      }
      if (ids.every((id) => result[id].status === "pending")) return upstreamFailed();
    }
  }

  // 4. Upsert caches.
  if (newParts.size > 0) await write(db.from("parts_cache").upsert([...newParts.values()], { onConflict: "part_id" }));
  if (newMaps.length > 0) await write(db.from("bricklink_map_cache").upsert(newMaps, { onConflict: "bricklink_id" }));
  return json({ parts: result, stale });
}

async function partsRebrickable(db: Db, ids: string[]): Promise<Response> {
  const now = Date.now();
  const result: Record<string, PartStatus> = {};
  let stale = false;
  const cached = await readParts(db, ids);
  const answer = (row: PartsCacheRow): PartStatus =>
    row.found ? { status: "found", part: toWirePart(row) } : { status: "not_found" };
  for (const id of ids) {
    const row = cached.get(id);
    if (row && isFresh(row.fetched_at, row.found ? TTL_DAYS.parts : TTL_DAYS.negative, now)) result[id] = answer(row);
  }
  const missing = ids.filter((id) => !result[id]);
  if (missing.length > 0) {
    try {
      const found = new Map((await partsByNums(missing)).map((p) => [p.part_num, p]));
      const stamp = nowIso();
      const rows: PartRow[] = missing.map((id) => (found.has(id) ? toPartRow(found.get(id)!, stamp) : notFoundRow(id, stamp)));
      for (const r of rows) result[r.part_id] = answer(r);
      await write(db.from("parts_cache").upsert(rows, { onConflict: "part_id" }));
    } catch {
      stale = true;
      for (const id of missing) {
        const row = cached.get(id);
        result[id] = row ? answer(row) : { status: "pending" };
      }
      if (ids.every((id) => result[id].status === "pending")) return upstreamFailed();
    }
  }
  return json({ parts: result, stale });
}

function parts(db: Db, body: Json): Promise<Response> | Response {
  if (body.id_type !== "bricklink" && body.id_type !== "rebrickable") return badRequest("id_type");
  const ids = validateIds(body.ids, 50);
  if (!ids) return badRequest("ids");
  return body.id_type === "bricklink" ? partsBricklink(db, ids) : partsRebrickable(db, ids);
}

// ---------------------------------------------------------------- part_colors
interface PartColorRow {
  part_id: string; color_id: number; element_ids: string[]; image_url: string | null; num_sets: number | null;
  found: boolean; fetched_at: string;
}
const wirePartColor = (r: PartColorRow) =>
  ({ color_id: r.color_id, image_url: r.image_url, element_ids: r.element_ids ?? [], num_sets: r.num_sets ?? 0 });

async function partColors(db: Db, body: Json): Promise<Response> {
  const ids = validateIds(body.part_ids, 5);
  if (!ids) return badRequest("part_ids");
  const now = Date.now();
  const lists = await select<{ part_id: string; fetched_at: string }>(
    db.from("part_color_lists_cache").select("*").in("part_id", ids));
  const listById = new Map(lists.map((l) => [l.part_id, l]));
  const cachedRows = await select<PartColorRow>(
    db.from("part_colors_cache").select("*").in("part_id", ids).eq("found", true));
  const cachedFor = (id: string) => cachedRows.filter((r) => r.part_id === id).map(wirePartColor);

  const out: Record<string, ReturnType<typeof wirePartColor>[]> = {};
  let stale = false;
  let failed = 0;
  for (const id of ids) {
    const l = listById.get(id);
    if (l && isFresh(l.fetched_at, TTL_DAYS.detail, now)) {
      out[id] = cachedFor(id);
      continue;
    }
    try {
      const page = await rb(`/parts/${encodeURIComponent(id)}/colors/?page_size=1000`);
      const stamp = nowIso();
      const rows: PartColorRow[] = ((page?.results ?? []) as Json[])
        .filter((c) => typeof c.color_id === "number")
        .map((c) => ({
          part_id: id, color_id: c.color_id, element_ids: Array.isArray(c.elements) ? c.elements.map(String) : [],
          image_url: c.part_img_url ?? null, num_sets: typeof c.num_sets === "number" ? c.num_sets : 0,
          found: true, fetched_at: stamp,
        }));
      if (rows.length > 0) await write(db.from("part_colors_cache").upsert(rows, { onConflict: "part_id,color_id" }));
      await write(db.from("part_color_lists_cache").upsert({ part_id: id, fetched_at: stamp }, { onConflict: "part_id" }));
      out[id] = rows.map(wirePartColor);
    } catch {
      stale = true;
      if (l) out[id] = cachedFor(id);
      else failed++;
    }
  }
  if (failed === ids.length) return upstreamFailed();
  return json({ parts: out, stale });
}

// ---------------------------------------------------------------- detail
interface SetsPageRow { part_id: string; color_id: number; page: number; total: number; sets: Json; fetched_at: string }
const PAGE_SIZE = 100;

async function detail(db: Db, body: Json): Promise<Response> {
  const partId = validateId(body.part_id);
  if (!partId) return badRequest("part_id");
  const colorId = validateInt(body.color_id, 0, 99999);
  if (colorId === null) return badRequest("color_id");
  const page = body.page === undefined ? 1 : validateInt(body.page, 1, 50);
  if (page === null) return badRequest("page");
  const now = Date.now();
  let stale = false;

  // part_color
  const [cachedPc] = await select<PartColorRow>(
    db.from("part_colors_cache").select("*").eq("part_id", partId).eq("color_id", colorId).limit(1));
  let pc: PartColorRow | null = cachedPc && isFresh(cachedPc.fetched_at, TTL_DAYS.detail, now) ? cachedPc : null;
  if (!pc) {
    try {
      const r = await rb(`/parts/${encodeURIComponent(partId)}/colors/${colorId}/`);
      const stamp = nowIso();
      pc = r
        ? {
          part_id: partId, color_id: colorId, element_ids: Array.isArray(r.elements) ? r.elements.map(String) : [],
          image_url: r.part_img_url ?? null, num_sets: typeof r.num_sets === "number" ? r.num_sets : 0,
          found: true, fetched_at: stamp,
        }
        : { part_id: partId, color_id: colorId, element_ids: [], image_url: null, num_sets: 0, found: false, fetched_at: stamp };
      await write(db.from("part_colors_cache").upsert(pc, { onConflict: "part_id,color_id" }));
    } catch {
      if (!cachedPc) return upstreamFailed();
      pc = cachedPc;
      stale = true;
    }
  }
  const partColor = {
    part_id: partId, color_id: colorId, found: pc.found, element_ids: pc.element_ids ?? [],
    image_url: pc.image_url, num_sets: pc.num_sets ?? 0,
  };
  if (!pc.found) return json({ part_color: partColor, sets: null, stale });

  // sets page
  const [cachedPage] = await select<SetsPageRow>(
    db.from("part_color_sets_cache").select("*").eq("part_id", partId).eq("color_id", colorId).eq("page", page).limit(1));
  let setsRow: SetsPageRow | null = cachedPage && isFresh(cachedPage.fetched_at, TTL_DAYS.detail, now) ? cachedPage : null;
  if (!setsRow) {
    try {
      const r = await rb(
        `/parts/${encodeURIComponent(partId)}/colors/${colorId}/sets/?page=${page}&page_size=${PAGE_SIZE}&ordering=-year`);
      const sets = ((r?.results ?? []) as Json[]).map((s) => ({
        set_num: String(s.set_num), name: String(s.name ?? ""), year: Number(s.year ?? 0),
        num_parts: Number(s.num_parts ?? 0), image_url: s.set_img_url ?? null,
      }));
      setsRow = { part_id: partId, color_id: colorId, page, total: Number(r?.count ?? 0), sets, fetched_at: nowIso() };
      await write(db.from("part_color_sets_cache").upsert(setsRow, { onConflict: "part_id,color_id,page" }));
    } catch {
      if (!cachedPage) return upstreamFailed();
      setsRow = cachedPage;
      stale = true;
    }
  }
  return json({
    part_color: partColor,
    sets: { total: setsRow.total, page, page_size: PAGE_SIZE, sets: setsRow.sets ?? [] },
    stale,
  });
}

// ---------------------------------------------------------------- set_qty
async function setQty(db: Db, body: Json): Promise<Response> {
  const setNum = typeof body.set_num === "string" && SET_NUM_RE.test(body.set_num) ? body.set_num : null;
  if (!setNum) return badRequest("set_num");
  const partId = validateId(body.part_id);
  if (!partId) return badRequest("part_id");
  const colorId = validateInt(body.color_id, 0, 99999);
  if (colorId === null) return badRequest("color_id");

  const [cached] = await select<{ quantity: number; fetched_at: string }>(
    db.from("set_part_qty_cache").select("quantity, fetched_at")
      .eq("set_num", setNum).eq("part_id", partId).eq("color_id", colorId).limit(1));
  const answer = (q: number, stale: boolean) => json({ quantity: q > 0 ? q : null, stale });
  if (cached && isFresh(cached.fetched_at, TTL_DAYS.setQty, Date.now())) return answer(cached.quantity, false);
  try {
    let page = await rb(`/sets/${encodeURIComponent(setNum)}/parts/?page_size=1000`);
    let total = 0;
    for (let n = 0; page && n < 3; n++) {
      total += sumSetQuantity(page.results ?? [], partId, colorId);
      page = n < 2 && typeof page.next === "string" ? await rbNext(page.next) : null;
    }
    await write(db.from("set_part_qty_cache").upsert(
      { set_num: setNum, part_id: partId, color_id: colorId, quantity: total, fetched_at: nowIso() },
      { onConflict: "set_num,part_id,color_id" }));
    return answer(total, false);
  } catch {
    return cached ? answer(cached.quantity, true) : upstreamFailed();
  }
}

// ---------------------------------------------------------------- palette
interface ColorRow { color_id: number; name: string; hex: string; is_trans: boolean; bricklink_id: number | null; fetched_at: string }

async function palette(db: Db): Promise<Response> {
  const now = Date.now();
  const colors = await select<ColorRow>(db.from("colors_cache").select("*").order("color_id"));
  const categories = await select<{ id: number; name: string }>(db.from("part_categories_cache").select("*").order("id"));
  const fresh = colors.length > 0 && categories.length > 0 &&
    colors.every((c) => isFresh(c.fetched_at, TTL_DAYS.palette, now));
  const wire = (cs: ColorRow[], cats: { id: number; name: string }[], stale: boolean) => json({
    colors: cs.map(({ color_id, name, hex, is_trans, bricklink_id }) => ({ color_id, name, hex, is_trans, bricklink_id })),
    categories: cats.map(({ id, name }) => ({ id, name })),
    stale,
  });
  if (fresh) return wire(colors, categories, false);
  try {
    const cs = await rb("/colors/?page_size=1000");
    const cats = await rb("/part_categories/?page_size=200");
    const stamp = nowIso();
    const colorRows: ColorRow[] = ((cs?.results ?? []) as Json[])
      .map(toWireColor).filter((c): c is NonNullable<typeof c> => c !== null)
      .map((c) => ({ ...c, fetched_at: stamp }))
      .sort((a, b) => a.color_id - b.color_id);
    const catRows = ((cats?.results ?? []) as Json[])
      .filter((c) => typeof c.id === "number")
      .map((c) => ({ id: c.id as number, name: String(c.name) }))
      .sort((a, b) => a.id - b.id);
    if (colorRows.length === 0 || catRows.length === 0) throw new Error("empty palette");
    await write(db.from("colors_cache").upsert(colorRows, { onConflict: "color_id" }));
    await write(db.from("part_categories_cache").upsert(catRows, { onConflict: "id" }));
    return wire(colorRows, catRows, false);
  } catch {
    return colors.length > 0 ? wire(colors, categories, true) : upstreamFailed();
  }
}

// ---------------------------------------------------------------- entry point
export default {
  fetch: withSupabase({ auth: "publishable" }, async (req, ctx) => {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return badRequest("op");
    const db = ctx.supabaseAdmin;
    switch (body.op) {
      case "parts": return parts(db, body);
      case "detail": return detail(db, body);
      case "part_colors": return partColors(db, body);
      case "set_qty": return setQty(db, body);
      case "palette": return palette(db);
      default: return badRequest("op");
    }
  }),
};
