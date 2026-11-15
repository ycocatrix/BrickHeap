// Local colour estimate (D6): CIEDE2000 ranking of a measured Lab against catalogue colours.
import type { CatalogColor, ColorId, Lab } from '../types';
import { ciede2000, hexToLab } from './lab';

/** 40 most common opaque colours (Rebrickable ids), by number of sets over basic parts. */
export const COMMON_OPAQUE_COLOR_IDS: readonly ColorId[] = [
  0, 15, 4, 71, 72, 14, 1, 19, 70, 2, 25, 28, 7, 27, 272, 322, 320, 84, 191, 29, 484, 3, 288, 85, 378, 321, 73,
  26, 30, 8, 5, 308, 226, 323, 10, 212, 31, 379, 326, 6,
];

export interface ColorMatch { colorId: ColorId; deltaE: number }

const NO_COLOR_ID = 9999;
const labCache = new Map<string, Lab>();

function labOfHex(hex: string): Lab {
  let lab = labCache.get(hex);
  if (!lab) {
    lab = hexToLab(hex);
    labCache.set(hex, lab);
  }
  return lab;
}

/** CIEDE2000 ranking. Skips transparent colours, colorId < 0 and 9999. Default k = 3. */
export function nearestColors(lab: Lab, colors: readonly CatalogColor[],
  opts?: { allowed?: ReadonlySet<ColorId>; k?: number }): ColorMatch[] {
  const k = opts?.k ?? 3;
  const allowed = opts?.allowed;
  const res: ColorMatch[] = [];
  for (const c of colors) {
    if (c.colorId < 0 || c.colorId === NO_COLOR_ID || c.isTrans) continue;
    if (allowed && !allowed.has(c.colorId)) continue;
    const ref = labOfHex(c.hex);
    if (Number.isNaN(ref[0])) continue; // malformed hex
    res.push({ colorId: c.colorId, deltaE: ciede2000(lab, ref) });
  }
  res.sort((p, q) => p.deltaE - q.deltaE || p.colorId - q.colorId);
  return k >= 0 ? res.slice(0, k) : res;
}
