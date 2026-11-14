// Pure mapping helpers for catalog-proxy (§6.2). NO import: this file is unit-tested from Jest
// (src/domain/catalog/__tests__/catalogMapping.test.ts) and also runs under Deno.

/** Subset of a Rebrickable `parts` result (with inc_part_details=1). */
export interface RbPart {
  part_num: string;
  name: string;
  part_cat_id: number | null;
  part_img_url: string | null;
  year_from?: number | null;
  year_to?: number | null;
  print_of?: string | null;
  external_ids?: Record<string, string[]>;
}

/** One `parts_cache` row (migration 2). */
export interface PartRow {
  part_id: string;
  name: string;
  part_cat_id: number | null;
  image_url: string | null;
  bricklink_ids: string[];
  lego_ids: string[];
  print_of: string | null;
  year_from: number | null;
  year_to: number | null;
  found: boolean;
  fetched_at: string;
}

/** Part as sent to the app (`parts` operation, `status: 'found'`). */
export interface WirePart {
  part_id: string;
  name: string;
  part_cat_id: number | null;
  image_url: string | null;
  bricklink_ids: string[];
  lego_ids: string[];
  print_of: string | null;
  year_from: number | null;
  year_to: number | null;
}

export const ID_RE = /^[A-Za-z0-9._-]{1,30}$/;
export const SET_NUM_RE = /^[A-Za-z0-9-]{1,20}$/;
export const DAY_MS = 86_400_000;
export const TTL_DAYS = { parts: 90, negative: 7, detail: 30, setQty: 180, palette: 30 } as const;

/** Distinct ids (first occurrence order), 1..max of them, each matching ID_RE; anything else → null. */
export function validateIds(ids: unknown, max: number): string[] | null {
  if (!Array.isArray(ids) || ids.length === 0) return null;
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    if (!out.includes(id)) out.push(id);
  }
  return out.length <= max ? out : null;
}

/** A single id matching ID_RE, else null. */
export function validateId(id: unknown): string | null {
  return typeof id === 'string' && ID_RE.test(id) ? id : null;
}

/** An integer in min..max (numbers or numeric strings), else null. */
export function validateInt(v: unknown, min: number, max: number): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** The result's BrickLink ids are missing/empty, or contain `id`. */
export function acceptsBricklinkId(p: RbPart, id: string): boolean {
  const bl = p.external_ids?.BrickLink;
  return !bl || bl.length === 0 || bl.includes(id);
}

/** `part_num === id` wins; else the single result; else the results with `print_of === null` (all when none)
 *  and among them the latest `year_to` (ties: lowest part_num). The others are alternates. Empty → null. */
export function pickPrimary(id: string, results: RbPart[]): { primary: RbPart; alternates: string[] } | null {
  if (results.length === 0) return null;
  let primary = results.find((p) => p.part_num === id);
  if (!primary) {
    if (results.length === 1) primary = results[0];
    else {
      const unprinted = results.filter((p) => p.print_of == null);
      const pool = unprinted.length > 0 ? unprinted : results;
      primary = [...pool].sort((a, b) =>
        (b.year_to ?? -1) - (a.year_to ?? -1) || (a.part_num < b.part_num ? -1 : a.part_num > b.part_num ? 1 : 0))[0];
    }
  }
  const chosen = primary;
  return { primary: chosen, alternates: results.filter((p) => p !== chosen).map((p) => p.part_num) };
}

export function toPartRow(p: RbPart, nowIso: string): PartRow {
  return {
    part_id: p.part_num,
    name: p.name,
    part_cat_id: p.part_cat_id ?? null,
    image_url: p.part_img_url ?? null,
    bricklink_ids: [...(p.external_ids?.BrickLink ?? [])],
    lego_ids: [...(p.external_ids?.LEGO ?? [])],
    print_of: p.print_of ?? null,
    year_from: p.year_from ?? null,
    year_to: p.year_to ?? null,
    found: true,
    fetched_at: nowIso,
  };
}

/** Negative `parts_cache` row (`found = false`). */
export function notFoundRow(partId: string, nowIso: string): PartRow {
  return {
    part_id: partId, name: partId, part_cat_id: null, image_url: null, bricklink_ids: [], lego_ids: [],
    print_of: null, year_from: null, year_to: null, found: false, fetched_at: nowIso,
  };
}

export function toWirePart(r: Omit<PartRow, 'found' | 'fetched_at'>): WirePart {
  return {
    part_id: r.part_id,
    name: r.name,
    part_cat_id: r.part_cat_id ?? null,
    image_url: r.image_url ?? null,
    bricklink_ids: r.bricklink_ids ?? [],
    lego_ids: r.lego_ids ?? [],
    print_of: r.print_of ?? null,
    year_from: r.year_from ?? null,
    year_to: r.year_to ?? null,
  };
}

/** fetched_at + ttlDays is still in the future. Unparsable → false. */
export function isFresh(fetchedAt: string, ttlDays: number, now: number): boolean {
  const t = Date.parse(fetchedAt);
  return Number.isFinite(t) && t + ttlDays * DAY_MS > now;
}

/** Step 3b (§6.2): ids whose last character is a digit get the mould-letter probes `<id>a`…`<id>d`. */
export function suffixProbeIds(id: string): string[] {
  return /\d$/.test(id) ? ['a', 'b', 'c', 'd'].map((s) => id + s) : [];
}

/** Chunks of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Rebrickable colour → palette wire colour; ids −1 and 9999 → null. */
export function toWireColor(c: { id: number; name: string; rgb: string | null; is_trans: boolean;
  external_ids?: { BrickLink?: { ext_ids?: number[] } } }):
  { color_id: number; name: string; hex: string; is_trans: boolean; bricklink_id: number | null } | null {
  if (c.id === -1 || c.id === 9999) return null;
  const bl = c.external_ids?.BrickLink?.ext_ids?.[0];
  return {
    color_id: c.id,
    name: c.name,
    hex: String(c.rgb ?? '').replace(/^#/, '').toUpperCase().padStart(6, '0').slice(0, 6),
    is_trans: c.is_trans === true,
    bricklink_id: typeof bl === 'number' ? bl : null,
  };
}

/** D15: sum of `quantity` over the set's non-spare rows matching part_num and colour id. */
export function sumSetQuantity(rows: readonly { part?: { part_num?: string }; color?: { id?: number };
  quantity?: number; is_spare?: boolean }[], partId: string, colorId: number): number {
  let total = 0;
  for (const r of rows) {
    if (r.is_spare === true) continue;
    if (r.part?.part_num === partId && r.color?.id === colorId) total += r.quantity ?? 0;
  }
  return total;
}
