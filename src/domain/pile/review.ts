// EX_06, RG_07, RG_09, RG_10: the review screen state is `pieces + overrides`; lines are re-derived by groupPieces.
import type {
  Candidate, CatalogPart, ColorId, DetectionId, IdentifiedPiece, ItemDelta, ListId, ReviewLine, ReviewState, ReviewSummary,
} from '../types';
import { itemKey } from '../keys';
import { groupPieces, pieceGroupKey } from './grouping';

const MAX_QUANTITY = 9999;

export function createReview(pieces: readonly IdentifiedPiece[]): ReviewState {
  return { pieces: [...pieces], quantities: {}, removed: [] };
}

export function reviewLines(state: ReviewState, sessionAdded?: Readonly<Record<string, number>>): ReviewLine[] {
  const removed = new Set(state.removed);
  return groupPieces(state.pieces)
    .filter((g) => !removed.has(g.key))
    .map((g) => {
      const override = state.quantities[g.key];
      const quantity = override === undefined ? g.count : override;
      const alreadyAdded = g.kind === 'ok' && g.partId !== null && g.colorId !== null
        ? sessionAdded?.[itemKey(g.partId, g.colorId)] ?? 0
        : 0;
      return { ...g, quantity, addable: g.kind === 'ok' && quantity > 0, alreadyAdded };
    });
}

export function reviewSummary(state: ReviewState): ReviewSummary {
  const byId = new Map(state.pieces.map((p) => [p.detection.id, p]));
  const s: ReviewSummary = { lines: 0, pieces: 0, toVerify: 0, colorToConfirm: 0, unknown: 0, partial: 0, canAdd: false };
  for (const line of reviewLines(state)) {
    switch (line.kind) {
      case 'ok': {
        if (!line.addable) break;
        s.lines += 1;
        s.pieces += line.quantity;
        const toVerify = line.detectionIds
          .map((id) => byId.get(id))
          .filter((p) => p !== undefined && p.level === 'review' && !p.partConfirmed).length;
        s.toVerify += Math.min(toVerify, line.quantity);
        break;
      }
      case 'color_to_confirm': s.colorToConfirm += line.quantity; break;
      case 'unknown': s.unknown += line.quantity; break;
      case 'partial': s.partial += line.quantity; break;
    }
  }
  s.canAdd = s.pieces > 0 && s.colorToConfirm === 0;
  return s;
}

function withoutKey<T>(rec: Record<string, T>, keys: Iterable<string>): Record<string, T> {
  const out = { ...rec };
  for (const k of keys) delete out[k];
  return out;
}

/** clamp 0..9999; 0 → removed. */
export function setLineQuantity(state: ReviewState, key: string, quantity: number): ReviewState {
  const q = Number.isFinite(quantity) ? Math.min(MAX_QUANTITY, Math.max(0, Math.round(quantity))) : 0;
  if (q === 0) return removeLine(state, key);
  return { ...state, quantities: { ...state.quantities, [key]: q } };
}

export function removeLine(state: ReviewState, key: string): ReviewState {
  return {
    ...state,
    quantities: withoutKey(state.quantities, [key]),
    removed: state.removed.includes(key) ? state.removed : [...state.removed, key],
  };
}

export function restoreLine(state: ReviewState, key: string): ReviewState {
  return state.removed.includes(key) ? { ...state, removed: state.removed.filter((k) => k !== key) } : state;
}

function membersOf(state: ReviewState, key: string): Set<DetectionId> {
  const g = groupPieces(state.pieces).find((x) => x.key === key);
  return new Set(g ? g.detectionIds : []);
}

/** Applies `fn` to the pieces whose id is in `ids`, then re-keys: the overrides of the old keys and of the keys the
 *  members land on are dropped (merged count), and those keys are no longer removed. */
function editMembers(state: ReviewState, ids: ReadonlySet<DetectionId>,
  fn: (p: IdentifiedPiece) => IdentifiedPiece): ReviewState {
  if (ids.size === 0) return state;
  const touched = new Set<string>();
  const pieces = state.pieces.map((p) => {
    if (!ids.has(p.detection.id)) return p;
    touched.add(pieceGroupKey(p).key);
    const next = fn(p);
    touched.add(pieceGroupKey(next).key);
    return next;
  });
  return {
    pieces,
    quantities: withoutKey(state.quantities, touched),
    removed: state.removed.filter((k) => !touched.has(k)),
  };
}

/** Sets { colorId, reliable: true, source: 'user' } on every member; the line re-keys and merges. */
export function setLineColor(state: ReviewState, key: string, colorId: ColorId): ReviewState {
  return editMembers(state, membersOf(state, key), (p) => ({
    ...p,
    color: { colorId, reliable: true, source: 'user', alternatives: p.color.alternatives.filter((c) => c !== colorId) },
  }));
}

/** « Tout confirmer »: setLineColor(key, current colorId) for every color_to_confirm line whose colorId is not null. */
export function confirmAllColors(state: ReviewState): ReviewState {
  let next = state;
  for (const line of reviewLines(state)) {
    if (line.kind === 'color_to_confirm' && line.colorId !== null) next = setLineColor(next, line.key, line.colorId);
  }
  return next;
}

export function confirmPartial(state: ReviewState, key: string): ReviewState {
  return editMembers(state, membersOf(state, key), (p) => ({ ...p, partialConfirmed: true }));
}

/** Explicit choice applied to every listed detection: candidate appended when absent, chosen = its index,
 *  part = `part`, partConfirmed = true (confidence 1, level 'accepted'). The line re-keys and may merge. */
export function chooseCandidate(state: ReviewState, detectionIds: readonly DetectionId[], candidate: Candidate,
  part: CatalogPart): ReviewState {
  return editMembers(state, new Set(detectionIds), (p) => {
    let candidates = p.identification.candidates;
    let chosen = candidates.findIndex((c) => c.bricklinkId === candidate.bricklinkId);
    if (chosen < 0) {
      candidates = [...candidates, candidate];
      chosen = candidates.length - 1;
    }
    return {
      ...p,
      identification: { ...p.identification, status: 'identified', candidates, error: null },
      chosen,
      part,
      partConfirmed: true,
      confidence: 1,
      level: 'accepted',
    };
  });
}

/** One delta per addable line. */
export function toDeltas(state: ReviewState, listId: ListId): ItemDelta[] {
  return reviewLines(state)
    .filter((l) => l.addable && l.partId !== null && l.colorId !== null)
    .map((l) => ({ listId, partId: l.partId as string, colorId: l.colorId as ColorId, delta: l.quantity }));
}
