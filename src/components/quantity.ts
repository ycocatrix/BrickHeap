// Pure helpers of QuantityStepper (no React Native import, covered by Jest).

export const QTY_MIN = 0;
export const QTY_MAX = 9999;

export function clampQuantity(v: number, min: number = QTY_MIN, max: number = QTY_MAX): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/** Typed text → committed value. Digits only (spaces ignored); anything else reverts to `previous`.
 *  A valid number is clamped to min..max. */
export function parseQuantityInput(text: string, previous: number, min: number = QTY_MIN, max: number = QTY_MAX): number {
  const t = text.replace(/\s/g, '');
  if (!/^\d+$/.test(t)) return previous;
  return clampQuantity(Number(t), min, max);
}

/** Normalises a search string: lower case, accents removed, trimmed. */
export function normalizeSearch(s: string): string {
  return stripAccents(s.toLowerCase()).trim();
}

const ACCENTS: Record<string, string> = {
  à: 'a', â: 'a', ä: 'a', á: 'a', ã: 'a', ç: 'c', é: 'e', è: 'e', ê: 'e', ë: 'e', î: 'i', ï: 'i', í: 'i',
  ô: 'o', ö: 'o', ó: 'o', õ: 'o', ù: 'u', û: 'u', ü: 'u', ú: 'u', ÿ: 'y', ñ: 'n', œ: 'oe', æ: 'ae',
};

/** String.prototype.normalize is not guaranteed under Hermes: explicit map for French (and common Latin) accents. */
function stripAccents(s: string): string {
  return s.replace(/[àâäáãçéèêëîïíôöóõùûüúÿñœæ]/g, (c) => ACCENTS[c] ?? c);
}
