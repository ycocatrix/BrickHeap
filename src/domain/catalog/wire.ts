// Pure parsing of catalog-proxy responses (§6.2) into the shared catalogue types. Never throws.
import type { CatalogPart, PartColorInfo, PartDetail, SetRef, SetsPage } from '../types';

export type WirePartStatus =
  | { status: 'found'; part: CatalogPart }
  | { status: 'not_found' }
  | { status: 'pending' };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/** Wire part (snake_case) → resolved CatalogPart; null when malformed. */
export function wireToPart(w: unknown): CatalogPart | null {
  if (!isObj(w)) return null;
  const partId = str(w.part_id);
  if (!partId) return null;
  return {
    partId,
    name: str(w.name) ?? partId,
    categoryId: num(w.part_cat_id),
    imageUrl: str(w.image_url),
    bricklinkIds: strArr(w.bricklink_ids),
    legoIds: strArr(w.lego_ids),
    printOf: str(w.print_of),
    yearFrom: num(w.year_from) || null,
    yearTo: num(w.year_to) || null,
    source: 'rebrickable',
    resolution: 'resolved',
  };
}

/** `parts` operation → status per requested id. Missing or malformed entries are absent from the map
 *  (the caller treats them as 'pending'). null when the body is not a parts response. */
export function parsePartsResponse(json: unknown): Map<string, WirePartStatus> | null {
  if (!isObj(json) || !isObj(json.parts)) return null;
  const out = new Map<string, WirePartStatus>();
  for (const [id, v] of Object.entries(json.parts)) {
    if (!isObj(v)) continue;
    if (v.status === 'found') {
      const part = wireToPart(v.part);
      if (part) out.set(id, { status: 'found', part });
    } else if (v.status === 'not_found') out.set(id, { status: 'not_found' });
    else if (v.status === 'pending') out.set(id, { status: 'pending' });
  }
  return out;
}

export interface WirePartColor { colorId: number; imageUrl: string | null; elementIds: string[]; numSets: number }

/** `part_colors` operation → colours per part id; null when malformed. */
export function parsePartColorsResponse(json: unknown): Map<string, WirePartColor[]> | null {
  if (!isObj(json) || !isObj(json.parts)) return null;
  const out = new Map<string, WirePartColor[]>();
  for (const [id, list] of Object.entries(json.parts)) {
    if (!Array.isArray(list)) continue;
    const colors: WirePartColor[] = [];
    for (const c of list) {
      if (!isObj(c)) continue;
      const colorId = num(c.color_id);
      if (colorId === null) continue;
      colors.push({ colorId, imageUrl: str(c.image_url), elementIds: strArr(c.element_ids), numSets: num(c.num_sets) ?? 0 });
    }
    out.set(id, colors);
  }
  return out;
}

function parseSet(s: unknown): SetRef | null {
  if (!isObj(s)) return null;
  const setNum = str(s.set_num);
  if (!setNum) return null;
  return { setNum, name: str(s.name) ?? '', year: num(s.year) ?? 0, numParts: num(s.num_parts) ?? 0, imageUrl: str(s.image_url) };
}

/** `detail` operation → PartDetail; null when malformed. */
export function parseDetailResponse(json: unknown, partId: string, colorId: number): PartDetail | null {
  if (!isObj(json) || !isObj(json.part_color)) return null;
  const pc = json.part_color;
  const partColor: PartColorInfo = {
    partId,
    colorId,
    found: pc.found !== false,
    elementIds: strArr(pc.element_ids),
    imageUrl: str(pc.image_url),
    numSets: num(pc.num_sets) ?? 0,
  };
  let sets: SetsPage | null = null;
  if (isObj(json.sets)) {
    const raw = Array.isArray(json.sets.sets) ? json.sets.sets : [];
    sets = {
      total: num(json.sets.total) ?? 0,
      page: num(json.sets.page) ?? 1,
      pageSize: num(json.sets.page_size) ?? 100,
      sets: raw.map(parseSet).filter((x): x is SetRef => x !== null),
    };
  }
  return { partColor, sets, stale: json.stale === true };
}

/** `set_qty` operation → quantity (null = not in the set); undefined when malformed. */
export function parseSetQtyResponse(json: unknown): number | null | undefined {
  if (!isObj(json) || !('quantity' in json)) return undefined;
  const q = json.quantity;
  if (q === null) return null;
  return typeof q === 'number' && q > 0 ? q : null;
}

/** Number of loaded pages still allowed / remaining: true when more sets exist beyond `loaded`. */
export function hasMoreSets(loaded: number, total: number, lastPage: number): boolean {
  return loaded < total && lastPage < 50;
}
