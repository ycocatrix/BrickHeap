// D6, RG_06: Brickognize colour first, cross-checked by the local Lab estimate.
import type { CatalogColor, ColorCandidate, ColorEstimate, ColorId, Lab, Palette } from '../types';
import { COMMON_OPAQUE_COLOR_IDS, nearestColors } from '../vision/color';

const MAX_ALTERNATIVES = 5;
const COMMON = new Set<ColorId>(COMMON_OPAQUE_COLOR_IDS);

/** See §4.5: four rules, first match wins; alternatives = distinct [bk…, local…] minus colorId, at most 5. */
export function fuseColor(input: { brickognize: readonly ColorCandidate[]; lab: Lab | null; palette: Palette }): ColorEstimate {
  const { brickognize, lab, palette } = input;
  const bk: { color: CatalogColor; score: number }[] = [];
  for (const c of [...brickognize].sort((a, b) => b.score - a.score)) {
    const color = palette.byBricklinkId.get(c.bricklinkColorId);
    if (color && !bk.some((x) => x.color.colorId === color.colorId)) bk.push({ color, score: c.score });
  }
  const local = lab ? nearestColors(lab, palette.colors, { allowed: COMMON, k: 3 }).map((m) => m.colorId) : [];

  let colorId: ColorId | null = null;
  let reliable = false;
  let source: ColorEstimate['source'] = 'none';
  const top = bk[0];
  if (top) {
    colorId = top.color.colorId;
    source = 'brickognize';
    reliable = top.score >= 0.5 && (
      top.color.isTrans || top.score >= 0.8 || local.includes(colorId) || (lab === null && top.score >= 0.7));
  } else if (local.length > 0) {
    colorId = local[0];
    source = 'local';
  }

  const alternatives: ColorId[] = [];
  for (const id of [...bk.map((x) => x.color.colorId), ...local]) {
    if (id !== colorId && !alternatives.includes(id)) alternatives.push(id);
    if (alternatives.length >= MAX_ALTERNATIVES) break;
  }
  return { colorId, reliable, source, alternatives };
}
