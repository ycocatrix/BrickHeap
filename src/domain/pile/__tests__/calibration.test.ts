import { buildCalibrationSession, computeMetrics, countDetected, parseExpected } from '../calibration';
import { SCORE_CALIBRATION } from '../thresholds';
import type { ScanResult } from '../../types';
import { piece } from '../testing/fixtures';

jest.mock('../../catalog/partInfo', () => jest.requireActual('../testing/fixtures').partInfoMock);

describe('parseExpected', () => {
  it('handles every separator, default quantity and the documented forms', () => {
    const r = parseExpected('3001/4 x3\n3020/0; 3062b x2, 3003\n\n  4073/15 ×4 ');
    expect(r.errors).toEqual([]);
    expect(r.lines).toEqual([
      { partId: '3001', colorId: 4, quantity: 3 },
      { partId: '3020', colorId: 0, quantity: 1 },
      { partId: '3062b', colorId: null, quantity: 2 },
      { partId: '3003', colorId: null, quantity: 1 },
      { partId: '4073', colorId: 15, quantity: 4 },
    ]);
  });
  it('sums duplicate keys', () => {
    expect(parseExpected('3001/4 x2\n3001/4\n3001 x1;3001').lines).toEqual([
      { partId: '3001', colorId: 4, quantity: 3 },
      { partId: '3001', colorId: null, quantity: 2 },
    ]);
  });
  it('reports error lines with their 1-based line number', () => {
    const r = parseExpected('3001/4 x2\n???\n3020/x\n3001 x0, 3003/1');
    expect(r.errors).toEqual([{ line: 2, text: '???' }, { line: 3, text: '3020/x' }, { line: 4, text: '3001 x0' }]);
    expect(r.lines).toEqual([{ partId: '3001', colorId: 4, quantity: 2 }, { partId: '3003', colorId: 1, quantity: 1 }]);
  });
  it('empty text', () => {
    expect(parseExpected('  \n ; , ')).toEqual({ lines: [], errors: [] });
  });
});

describe('countDetected', () => {
  it('counts ok and color_to_confirm groups (colour null when unreliable)', () => {
    const lines = countDetected([
      piece({ id: 'a' }), piece({ id: 'b', x: 0.5 }),
      piece({ id: 'c', reliable: false, y: 0.5 }), piece({ id: 'd', colorId: null, reliable: false, y: 0.6 }),
      piece({ id: 'x', partial: true, y: 0.7 }), piece({ id: 'u', partId: null, confidence: 0, y: 0.8 }),
    ]);
    expect(lines).toEqual([{ partId: '3001', colorId: 4, quantity: 2 }, { partId: '3001', colorId: null, quantity: 2 }]);
  });
});

describe('computeMetrics', () => {
  const L = (partId: string, colorId: number | null, quantity: number) => ({ partId, colorId, quantity });
  it('perfect match', () => {
    const m = computeMetrics([L('3001', 4, 3), L('3020', 0, 1)], [L('3020', 0, 1), L('3001', 4, 3)]);
    expect(m).toMatchObject({ precision: 1, recall: 1, partPrecision: 1, partRecall: 1, countExpected: 4,
      countDetected: 4, countError: 0, tp: 4, fp: 0, fn: 0 });
    expect(m.rows).toEqual([
      { partId: '3001', colorId: 4, expected: 3, detected: 3 },
      { partId: '3020', colorId: 0, expected: 1, detected: 1 },
    ]);
  });
  it('one false positive', () => {
    const m = computeMetrics([L('3001', 4, 3), L('3003', 1, 1)], [L('3001', 4, 3)]);
    expect(m).toMatchObject({ precision: 0.75, recall: 1, tp: 3, fp: 1, fn: 0, countError: 1 });
    expect(m.rows).toContainEqual({ partId: '3003', colorId: 1, expected: 0, detected: 1 });
  });
  it('one false negative', () => {
    const m = computeMetrics([L('3001', 4, 2)], [L('3001', 4, 3)]);
    expect(m).toMatchObject({ precision: 1, recall: 2 / 3, tp: 2, fp: 0, fn: 1, countError: -1 });
  });
  it('colour-only error: precision drops, partPrecision stays 1', () => {
    const m = computeMetrics([L('3001', 5, 1)], [L('3001', 4, 1)]);
    expect(m).toMatchObject({ precision: 0, recall: 0, partPrecision: 1, partRecall: 1, tp: 0, fp: 1, fn: 1 });
    expect(m.rows).toEqual([
      { partId: '3001', colorId: 4, expected: 1, detected: 0 },
      { partId: '3001', colorId: 5, expected: 0, detected: 1 },
    ]);
  });
  it('an expected line without colour matches any colour of that part', () => {
    const m = computeMetrics([L('3001', 4, 2), L('3001', 15, 1), L('3001', null, 1)], [L('3001', null, 4)]);
    expect(m).toMatchObject({ precision: 1, recall: 1, tp: 4 });
    expect(m.rows).toEqual([{ partId: '3001', colorId: null, expected: 4, detected: 4 }]);
  });
  it('a coloured expected line takes its colour first, the colourless line the rest', () => {
    const m = computeMetrics([L('3001', 4, 2), L('3001', 15, 1)], [L('3001', 4, 1), L('3001', null, 1)]);
    expect(m.rows).toEqual([
      { partId: '3001', colorId: null, expected: 1, detected: 1 },
      { partId: '3001', colorId: 4, expected: 1, detected: 2 },
    ]);
    expect(m).toMatchObject({ tp: 2, fp: 1, fn: 0 });
  });
  it('empty inputs give zeros', () => {
    expect(computeMetrics([], [])).toEqual({ precision: 0, recall: 0, partPrecision: 0, partRecall: 0,
      countExpected: 0, countDetected: 0, countError: 0, tp: 0, fp: 0, fn: 0, rows: [] });
    expect(computeMetrics([L('3001', 4, 1)], [])).toMatchObject({ precision: 0, recall: 0, fp: 1 });
  });
});

describe('buildCalibrationSession', () => {
  it('builds the EX_11 JSON without any image', () => {
    const result: ScanResult = {
      id: 's1', mode: 'inventory', frame: { uri: 'file:///photo.jpg', width: 1920, height: 1440 }, background: 'plain',
      wholeImage: false,
      pieces: [piece({ id: 'a' }), piece({ id: 'u', partId: null, confidence: 0, status: 'unavailable' })],
      timings: { prepareMs: 1, segmentMs: 2, identifyMs: 3, catalogMs: 4, totalMs: 10, brickognizeCalls: 2 },
    };
    const s = buildCalibrationSession({ id: 'cal1', createdAt: '2026-11-15T10:00:00.000Z', platform: 'ios 18',
      appVersion: '1.0.0', result, expected: [{ partId: '3001', colorId: 4, quantity: 2 }] });
    expect(s).toMatchObject({ version: 1, id: 'cal1', background: 'plain', platform: 'ios 18', appVersion: '1.0.0',
      config: { thresholds: { accepted: 0.8, review: 0.5 } } });
    expect(s.config.scoreCalibration).toEqual(SCORE_CALIBRATION);
    expect(s.detections[0]).toEqual({ box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, partial: false, status: 'identified',
      bricklinkId: '3001', partId: '3001', colorId: 4, colorSource: 'brickognize', rawScore: 0.9, confidence: 0.9,
      level: 'accepted' });
    expect(s.detections[1]).toMatchObject({ status: 'unavailable', bricklinkId: null, partId: null, rawScore: 0 });
    expect(s.metrics).toMatchObject({ precision: 1, recall: 0.5, tp: 1, fn: 1 });
    const json = JSON.stringify(s);
    expect(json).not.toContain('file://');
    expect(json).not.toContain('crop');
  });
});
