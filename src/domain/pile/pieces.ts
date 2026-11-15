// Pure constructors of IdentifiedPiece used by the scan pipeline and the scan store (WP3).
import type { CatalogPart, Detection, Identification, IdentifiedPiece, Palette } from '../types';
import { provisionalPart } from '../catalog/partInfo';
import { fuseColor } from './colorFusion';
import { evaluatePiece } from './thresholds';

export const PENDING_IDENTIFICATION: Identification =
  { status: 'pending', candidates: [], colors: [], boxScore: 0, error: null };

/** A detection waiting for (or not yet sent to) Brickognize. */
export function pendingPiece(detection: Detection): IdentifiedPiece {
  return {
    detection,
    identification: PENDING_IDENTIFICATION,
    chosen: -1,
    part: null,
    color: { colorId: null, reliable: false, source: 'none', alternatives: [] },
    confidence: 0,
    level: 'unknown',
    partConfirmed: false,
    partialConfirmed: false,
    cropUri: null,
  };
}

/** Marks a piece as queued again (EX_09 retry), keeping its detection and user flags. */
export function markPending(p: IdentifiedPiece): IdentifiedPiece {
  return { ...pendingPiece(p.detection), partialConfirmed: p.partialConfirmed, cropUri: p.cropUri };
}

/** Piece built from a Brickognize answer: colour fusion (D6), provisional part of the top candidate (D7,
 *  immediate), calibrated confidence (D5). */
export function buildPiece(detection: Detection, identification: Identification, palette: Palette | null,
  cropUri: string | null): IdentifiedPiece {
  const chosen = identification.status === 'identified' && identification.candidates.length > 0 ? 0 : -1;
  const part: CatalogPart | null = chosen >= 0 ? provisionalPart(identification.candidates[0], 'pending') : null;
  const color = palette
    ? fuseColor({ brickognize: identification.colors, lab: detection.lab, palette })
    : { colorId: null, reliable: false, source: 'none' as const, alternatives: [] };
  const { confidence, level } = evaluatePiece({ identification, chosen, partConfirmed: false });
  return {
    detection, identification, chosen, part, color, confidence, level,
    partConfirmed: false, partialConfirmed: false, cropUri,
  };
}

/** Swaps the catalogue part (resolved or provisional) of the chosen candidate. */
export function withPart(p: IdentifiedPiece, part: CatalogPart): IdentifiedPiece {
  return { ...p, part };
}

export function samePart(a: CatalogPart | null, b: CatalogPart | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.partId === b.partId && a.source === b.source && a.resolution === b.resolution && a.name === b.name
    && a.imageUrl === b.imageUrl;
}
