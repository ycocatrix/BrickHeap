// EX_10 / EX_11: expected list parsing, detection counts, precision / recall and the exported session JSON.
import type {
  CalibrationDetection, CalibrationMetrics, CalibrationRow, CalibrationSession, ColorId, CountedLine, IdentifiedPiece,
  PartId, ScanResult,
} from '../types';
import { groupPieces } from './grouping';
import { SCORE_CALIBRATION, THRESHOLDS } from './thresholds';

const ENTRY = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s*\/\s*(\d+))?(?:\s+[x×*]\s*(\d+)|\s*[x×*]\s*(\d+))?$/;
const lineKey = (partId: PartId, colorId: ColorId | null) => `${partId}|${colorId ?? '?'}`;

function addLine(map: Map<string, CountedLine>, partId: PartId, colorId: ColorId | null, quantity: number): void {
  const key = lineKey(partId, colorId);
  const cur = map.get(key);
  if (cur) cur.quantity += quantity;
  else map.set(key, { partId, colorId, quantity });
}

/** One entry per line: `<partId>[/<colorId>] [x<qty>]`, e.g. `3001/4 x3`, `3020/0`, `3062b x2`.
 *  Separators: newline, ';' or ','. Quantity defaults to 1. Duplicate keys are summed. `line` is 1-based. */
export function parseExpected(text: string): { lines: CountedLine[]; errors: { line: number; text: string }[] } {
  const map = new Map<string, CountedLine>();
  const errors: { line: number; text: string }[] = [];
  text.split(/\r?\n/).forEach((row, i) => {
    for (const raw of row.split(/[;,]/)) {
      const entry = raw.trim();
      if (!entry) continue;
      const m = ENTRY.exec(entry);
      const qty = m ? Number(m[3] ?? m[4] ?? '1') : 0;
      // 'x<qty>' glued to the part id ('3001x3') is read as a part id: ids may contain letters, so a space is needed.
      if (!m || !Number.isInteger(qty) || qty < 1) {
        errors.push({ line: i + 1, text: entry });
        continue;
      }
      addLine(map, m[1], m[2] === undefined ? null : Number(m[2]), qty);
    }
  });
  return { lines: [...map.values()], errors };
}

/** Counts pieces of 'ok' and 'color_to_confirm' groups (colorId null when not reliable). */
export function countDetected(pieces: readonly IdentifiedPiece[]): CountedLine[] {
  const map = new Map<string, CountedLine>();
  for (const g of groupPieces(pieces)) {
    if (g.partId === null) continue;
    if (g.kind === 'ok') addLine(map, g.partId, g.colorId, g.count);
    else if (g.kind === 'color_to_confirm') addLine(map, g.partId, null, g.count);
  }
  return [...map.values()];
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : 0);

function aggregate(lines: readonly CountedLine[]): Map<string, CountedLine> {
  const map = new Map<string, CountedLine>();
  for (const l of lines) if (l.quantity > 0) addLine(map, l.partId, l.colorId, l.quantity);
  return map;
}

/** An expected line with colorId null matches any colour of that part (not claimed by a coloured expected line).
 *  Every detected line falls in exactly one row; tp = Σ min(detected, expected) over rows. Empty denominators give 0. */
export function computeMetrics(detected: readonly CountedLine[], expected: readonly CountedLine[]): CalibrationMetrics {
  const det = aggregate(detected);
  const exp = aggregate(expected);
  const rows = new Map<string, CalibrationRow>();
  for (const [key, e] of exp) rows.set(key, { partId: e.partId, colorId: e.colorId, expected: e.quantity, detected: 0 });
  for (const [key, d] of det) {
    const exact = d.colorId !== null ? rows.get(key) : undefined;
    const target = (exact && exact.expected > 0 ? exact : undefined)
      ?? (exp.has(lineKey(d.partId, null)) ? rows.get(lineKey(d.partId, null)) : undefined);
    if (target) target.detected += d.quantity;
    else {
      const own = rows.get(key);
      if (own) own.detected += d.quantity;
      else rows.set(key, { partId: d.partId, colorId: d.colorId, expected: 0, detected: d.quantity });
    }
  }
  const list = [...rows.values()].sort((a, b) =>
    (a.partId < b.partId ? -1 : a.partId > b.partId ? 1 : 0) || (a.colorId ?? -1) - (b.colorId ?? -1));

  let tp = 0;
  let countDetected = 0;
  let countExpected = 0;
  for (const r of list) {
    tp += Math.min(r.detected, r.expected);
    countDetected += r.detected;
    countExpected += r.expected;
  }

  const partDet = new Map<PartId, number>();
  const partExp = new Map<PartId, number>();
  for (const d of det.values()) partDet.set(d.partId, (partDet.get(d.partId) ?? 0) + d.quantity);
  for (const e of exp.values()) partExp.set(e.partId, (partExp.get(e.partId) ?? 0) + e.quantity);
  let partTp = 0;
  for (const [partId, n] of partDet) partTp += Math.min(n, partExp.get(partId) ?? 0);

  return {
    precision: ratio(tp, countDetected),
    recall: ratio(tp, countExpected),
    partPrecision: ratio(partTp, countDetected),
    partRecall: ratio(partTp, countExpected),
    countExpected,
    countDetected,
    countError: countDetected - countExpected,
    tp,
    fp: countDetected - tp,
    fn: countExpected - tp,
    rows: list,
  };
}

function toCalibrationDetection(p: IdentifiedPiece): CalibrationDetection {
  const cand = p.chosen >= 0 ? p.identification.candidates[p.chosen] : undefined;
  return {
    box: { ...p.detection.box },
    partial: p.detection.partial,
    status: p.identification.status,
    bricklinkId: cand?.bricklinkId ?? null,
    partId: p.part?.partId ?? null,
    colorId: p.color.colorId,
    colorSource: p.color.source,
    rawScore: cand?.rawScore ?? 0,
    confidence: p.confidence,
    level: p.level,
  };
}

/** EX_11 export: boxes, scores, ids and timings — no image (cropUri is not copied), no personal data. */
export function buildCalibrationSession(input: { id: string; createdAt: string; platform: string; appVersion: string;
  result: ScanResult; expected: readonly CountedLine[] }): CalibrationSession {
  const { result } = input;
  return {
    version: 1,
    id: input.id,
    createdAt: input.createdAt,
    platform: input.platform,
    appVersion: input.appVersion,
    background: result.background,
    timings: { ...result.timings },
    config: {
      thresholds: { accepted: THRESHOLDS.accepted, review: THRESHOLDS.review },
      scoreCalibration: SCORE_CALIBRATION.map(([raw, conf]) => [raw, conf] as const),
    },
    detections: result.pieces.map(toCalibrationDetection),
    expected: input.expected.map((l) => ({ ...l })),
    metrics: computeMetrics(countDetected(result.pieces), input.expected),
  };
}
