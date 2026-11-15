// RG_05, RG_06, RG_03: deterministic grouping of identified pieces into lines.
import type { Candidate, DetectionId, GroupKind, IdentifiedPiece, PileGroup } from '../types';
import { partLabel } from '../catalog/partInfo';
import { confidenceLevel } from './thresholds';

const MAX_LINE_CANDIDATES = 5;

/** Group key and kind of one piece (first match wins, §4.5). */
export function pieceGroupKey(p: IdentifiedPiece): { key: string; kind: GroupKind } {
  const id = p.detection.id;
  if (p.level === 'unknown' || p.part === null) return { key: `u:${id}`, kind: 'unknown' };
  if (p.detection.partial && !p.partialConfirmed) return { key: `x:${id}`, kind: 'partial' };
  const partId = p.part.partId;
  if (p.color.colorId === null || !p.color.reliable) {
    return { key: `c:${partId}|${p.color.colorId ?? '?'}`, kind: 'color_to_confirm' };
  }
  return { key: `p:${partId}|${p.color.colorId}`, kind: 'ok' };
}

/** Top-to-bottom, then left-to-right, then id: a stable order independent of the input order. */
export function comparePosition(a: IdentifiedPiece, b: IdentifiedPiece): number {
  const da = a.detection.box;
  const db = b.detection.box;
  return da.y - db.y || da.x - db.x || (a.detection.id < b.detection.id ? -1 : a.detection.id > b.detection.id ? 1 : 0);
}

const KIND_ORDER: Record<GroupKind, number> = { ok: 0, color_to_confirm: 1, partial: 2, unknown: 3 };
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function safeLabel(name: string): string {
  try {
    return partLabel(name);
  } catch {
    return name;
  }
}

/** Deterministic. A provisional part (source 'brickognize') counts as a known part.
 *  Order: ok (count desc, name asc), color_to_confirm, partial, unknown (top-to-bottom of the image). */
export function groupPieces(pieces: readonly IdentifiedPiece[]): PileGroup[] {
  const sorted = [...pieces].sort(comparePosition);
  const groups = new Map<string, { kind: GroupKind; members: IdentifiedPiece[] }>();
  for (const p of sorted) {
    const { key, kind } = pieceGroupKey(p);
    const g = groups.get(key);
    if (g) g.members.push(p);
    else groups.set(key, { kind, members: [p] });
  }
  const out: (PileGroup & { firstIndex: number })[] = [];
  for (const [key, { kind, members }] of groups) {
    const first = members[0];
    const known = kind !== 'unknown' && first.part !== null;
    const confidence = Math.min(...members.map((m) => m.confidence));
    out.push({
      key,
      kind,
      partId: known && first.part ? first.part.partId : null,
      colorId: first.color.colorId,
      name: known && first.part ? safeLabel(first.part.name) : '',
      imageUrl: known && first.part ? first.part.imageUrl : null,
      detectionIds: members.map((m) => m.detection.id),
      count: members.length,
      confidence,
      level: confidenceLevel(confidence),
      provisional: known && first.part?.source === 'brickognize',
      cropUri: members.find((m) => m.cropUri)?.cropUri ?? null,
      firstIndex: sorted.indexOf(first),
    });
  }
  out.sort((a, b) => {
    const k = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (k !== 0) return k;
    if (a.kind === 'ok' || a.kind === 'color_to_confirm') {
      return b.count - a.count || cmpStr(a.name, b.name) || cmpStr(a.key, b.key);
    }
    return a.firstIndex - b.firstIndex;
  });
  return out.map(({ firstIndex: _firstIndex, ...g }) => g);
}

/** Union of the members' candidates by bricklinkId (max rawScore, best first, at most 5). */
export function lineCandidates(pieces: readonly IdentifiedPiece[], detectionIds: readonly DetectionId[]): Candidate[] {
  const ids = new Set(detectionIds);
  const best = new Map<string, Candidate>();
  for (const p of pieces) {
    if (!ids.has(p.detection.id)) continue;
    for (const c of p.identification.candidates) {
      const cur = best.get(c.bricklinkId);
      if (!cur || c.rawScore > cur.rawScore) best.set(c.bricklinkId, c);
    }
  }
  return [...best.values()]
    .sort((a, b) => b.rawScore - a.rawScore || cmpStr(a.bricklinkId, b.bricklinkId))
    .slice(0, MAX_LINE_CANDIDATES);
}
