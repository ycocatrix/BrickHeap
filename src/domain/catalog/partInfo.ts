// Pure catalogue helpers (EX_12, EX_13, EX_14, D7, D18). Imports only types and the French catalogue labels.
import type { Candidate, CatalogPart, PartDimensions, SetRef } from '../types';
import { CATEGORY_NAMES_FR, PART_WORDS_FR } from '../../i18n/fr/catalog';

const WORDS_BY_LENGTH = [...PART_WORDS_FR].sort((a, b) => b[0].length - a[0].length);

function startsWithWord(name: string, word: string): boolean {
  if (name.length < word.length) return false;
  if (name.slice(0, word.length).toLowerCase() !== word.toLowerCase()) return false;
  const next = name.charAt(word.length);
  return next === '' || !/[A-Za-z0-9]/.test(next);
}

/** French display label (D18): leading words translated through PART_WORDS_FR (longest match first, case kept for
 *  the rest), ' x ' → ' × '. 'Brick 2 x 4' → 'Brique 2 × 4'; no entry → original name (with ×). */
export function partLabel(name: string): string {
  let out = name;
  for (const [en, fr] of WORDS_BY_LENGTH) {
    if (startsWithWord(name, en)) {
      out = fr + name.slice(en.length);
      break;
    }
  }
  return out.replace(/ x /g, ' × ');
}

/** CATEGORY_NAMES_FR[id] ?? fallback (Rebrickable name) ?? null. */
export function categoryLabel(id: number | null, fallback: string | null): string | null {
  if (id !== null && Object.prototype.hasOwnProperty.call(CATEGORY_NAMES_FR, id)) return CATEGORY_NAMES_FR[id];
  return fallback ?? null;
}

/** D7 provisional part from a Brickognize candidate. */
export function provisionalPart(c: Pick<Candidate, 'bricklinkId' | 'name' | 'imageUrl'>,
  resolution: 'pending' | 'not_found'): CatalogPart {
  return {
    partId: c.bricklinkId,
    name: c.name,
    categoryId: null,
    imageUrl: c.imageUrl,
    bricklinkIds: [c.bricklinkId],
    legoIds: [],
    printOf: null,
    yearFrom: null,
    yearTo: null,
    source: 'brickognize',
    resolution,
  };
}

const DIMENSIONS = /(\d+(?:\/\d+)?)\s*x\s*(\d+(?:\/\d+)?)(?:\s*x\s*(\d+(?:\s\d+\/\d+|\/\d+)?))?/;

/** 'Brick 2 x 4' → { label: '2 × 4', studsX: '2', studsY: '4', height: null }; no match → null (UI shows « — »). */
export function parseDimensions(name: string): PartDimensions | null {
  const m = DIMENSIONS.exec(name);
  if (!m) return null;
  const [, studsX, studsY, height] = m;
  const h = height ?? null;
  return { label: h ? `${studsX} × ${studsY} × ${h}` : `${studsX} × ${studsY}`, studsX, studsY, height: h };
}

/** LEGO design id: the legoIds entry equal to the numeric root of partId, else legoIds[0], else partId. */
export function designId(part: Pick<CatalogPart, 'partId' | 'legoIds'>): string {
  const root = /^\d+/.exec(part.partId)?.[0];
  if (root && part.legoIds.includes(root)) return root;
  return part.legoIds[0] ?? part.partId;
}

/** EX_13: Pick a Brick search URL; id = last element id when known, else designId(part). */
export function pickABrickUrl(part: Pick<CatalogPart, 'partId' | 'legoIds'>, elementIds?: readonly string[]): string {
  const id = elementIds && elementIds.length > 0 ? elementIds[elementIds.length - 1] : designId(part);
  return `https://www.lego.com/fr-fr/pick-and-build/pick-a-brick?query=${encodeURIComponent(id)}`;
}

/** Lower case, diacritics removed. */
export function normalizeText(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** EX_14 client-side filter over loaded pages: case/diacritics-insensitive match on name or set number. */
export function filterSets(sets: readonly SetRef[], filter: { query: string; year: number | null }): SetRef[] {
  const q = normalizeText(filter.query);
  return sets.filter((s) =>
    (filter.year === null || s.year === filter.year) &&
    (q === '' || normalizeText(s.name).includes(q) || normalizeText(s.setNum).includes(q)));
}

/** Distinct, descending. */
export function setYears(sets: readonly SetRef[]): number[] {
  return [...new Set(sets.map((s) => s.year))].sort((a, b) => b - a);
}
