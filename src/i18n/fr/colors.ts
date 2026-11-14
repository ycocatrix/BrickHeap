import type { CatalogColor } from '@/domain/types';

/** French names of the common palette, keyed by Rebrickable colour id (checked against the live palette 2026-11-14). */
export const COLOR_NAMES_FR: Readonly<Record<number, string>> = {
  0: 'Noir',
  15: 'Blanc',
  4: 'Rouge',
  71: 'Gris bleuté clair',
  72: 'Gris bleuté foncé',
  14: 'Jaune',
  1: 'Bleu',
  19: 'Beige',
  70: 'Brun rougeâtre',
  2: 'Vert',
  25: 'Orange',
  28: 'Beige foncé',
  7: 'Gris clair (ancien)',
  27: 'Vert citron',
  272: 'Bleu foncé',
  47: 'Transparent',
  322: 'Azur moyen',
  320: 'Rouge foncé',
  84: 'Nougat moyen',
  191: 'Orange clair vif',
  29: 'Rose vif',
  36: 'Rouge transparent',
  484: 'Orange foncé',
  3: 'Turquoise foncé',
  46: 'Jaune transparent',
  288: 'Vert foncé',
  85: 'Violet foncé',
  378: 'Vert sable',
  41: 'Bleu clair transparent',
  321: 'Azur foncé',
  73: 'Bleu moyen',
  26: 'Magenta',
  30: 'Lavande moyen',
  8: 'Gris foncé (ancien)',
  5: 'Rose foncé',
  182: 'Orange transparent',
  308: 'Brun foncé',
  226: 'Jaune clair vif',
  33: 'Bleu foncé transparent',
  323: 'Aqua clair',
  10: 'Vert vif',
  212: 'Bleu clair vif',
  31: 'Lavande',
  379: 'Bleu sable',
  326: 'Vert olive',
  297: 'Or perlé',
  34: 'Vert transparent',
  6: 'Brun',
};

/** French name, else the Rebrickable name, '—' for null. */
export function colorLabel(color: Pick<CatalogColor, 'colorId' | 'name'> | null): string {
  if (!color) return '—';
  return COLOR_NAMES_FR[color.colorId] ?? color.name;
}
