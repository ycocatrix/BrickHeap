// Display helpers shared by the overlay, the drawer and the review screen (WP4).
import type { ColorId, IdentifiedPiece, Palette } from '@/domain/types';
import { parseDimensions, partLabel } from '@/domain/catalog/partInfo';
import { colorLabel } from '@/i18n/fr/colors';
import { fmtPercent, tpl } from '@/i18n/format';
import { scanner } from '@/i18n/fr/scanner';
import { pieceName, pieceStatus, type PieceStatus } from './scannerLogic';

export interface ColorInfo { label: string; hex: string | null; isTrans: boolean }

/** French colour label + hex; '?' dot (hex null) when unknown or not in the palette yet. */
export function colorInfo(palette: Palette | null, colorId: ColorId | null): ColorInfo {
  if (colorId == null) return { label: '—', hex: null, isTrans: false };
  const c = palette?.byId.get(colorId) ?? null;
  if (!c) return { label: '—', hex: null, isTrans: false };
  return { label: colorLabel(c), hex: c.hex, isTrans: c.isTrans };
}

/** French display name; '' → « Pièce inconnue ». */
export function displayName(name: string): string {
  return name ? partLabel(name) : scanner.box.unknownName;
}

/** Overlay chip label: dimensions (« 2 × 4 ») when the name has some, else the French name. */
export function shortLabel(name: string): string {
  if (!name) return scanner.box.unknownName;
  return parseDimensions(name)?.label ?? partLabel(name);
}

export function statusText(s: PieceStatus): string {
  switch (s) {
    case 'too_small':
      return scanner.status.tooSmall;
    default:
      return scanner.status[s];
  }
}

/** « {nom} {couleur}, {n} %, {statut}, appuyer pour ouvrir » (§7.2). */
export function a11yLabel(input: { name: string; color: string; confidence: number; status: string }): string {
  return tpl(scanner.box.a11y, {
    name: input.name,
    color: input.color === '—' ? '' : input.color,
    percent: fmtPercent(input.confidence),
    status: input.status,
  }).replace(/\s+,/g, ',');
}

export interface PieceView {
  status: PieceStatus;
  name: string;
  short: string;
  color: ColorInfo;
  a11y: string;
}

export function pieceView(p: IdentifiedPiece, palette: Palette | null): PieceView {
  const status = pieceStatus(p);
  const raw = pieceName(p);
  const color = colorInfo(palette, p.color.colorId);
  const name = displayName(raw);
  let statusLabel = statusText(status);
  if (p.detection.partial && !p.partialConfirmed) statusLabel += ', ' + scanner.box.partial;
  return {
    status,
    name,
    short: shortLabel(raw),
    color,
    a11y: a11yLabel({ name, color: color.label, confidence: p.confidence, status: statusLabel }),
  };
}
