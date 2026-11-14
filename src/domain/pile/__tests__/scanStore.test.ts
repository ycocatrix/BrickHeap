// src/state/scanStore.ts acceptance checks (§5.3) with mocked services and WP2 stand-ins.
import type { Detection, Identification, IdentifiedPiece, ScanFrame } from '@/domain/types';
import { scanActions, scanStore } from '@/state/scanStore';
import { buildPiece } from '@/domain/pile/pieces';
import { reviewLines } from '@/domain/pile/review';
import { cand, color, palette, segResult } from '../testing/fixtures';

jest.mock('@/services/scanPipeline', () => ({ segmentLive: jest.fn(), segmentPhoto: jest.fn(), identifyDetections: jest.fn() }));
jest.mock('@/services/imaging', () => ({ deleteTempFiles: jest.fn(async () => undefined) }));
jest.mock('@/services/catalog', () => ({ resolveCandidates: jest.fn(async () => new Map()) }));
jest.mock('@/data/inventoryRepo', () => ({ applyDeltas: jest.fn(), setLastListId: jest.fn(async () => undefined) }));
jest.mock('@/domain/catalog/partInfo', () => jest.requireActual('../testing/fixtures').partInfoMock);
jest.mock('@/domain/vision/color', () => ({ COMMON_OPAQUE_COLOR_IDS: [0, 4], nearestColors: () => [] }));
jest.mock('@/domain/vision/tracker', () => jest.requireActual('../testing/fixtures').visionMock.tracker);
jest.mock('@/domain/vision/geometry', () => jest.requireActual('../testing/fixtures').visionMock.geometry);
jest.mock('@/domain/vision/detections', () => jest.requireActual('../testing/fixtures').visionMock.detections);

const pipeline = jest.requireMock('@/services/scanPipeline') as Record<'segmentLive' | 'segmentPhoto' | 'identifyDetections', jest.Mock>;
const imaging = jest.requireMock('@/services/imaging') as { deleteTempFiles: jest.Mock };
const repo = jest.requireMock('@/data/inventoryRepo') as Record<'applyDeltas' | 'setLastListId', jest.Mock>;

const PAL = palette([color(4, 5), color(0, 11)]);
const VIEW = { width: 390, height: 700 };
const flush = () => new Promise((r) => setTimeout(r, 0));
const ident = (id: string, colorScore = 0.9): Identification => ({
  status: 'identified', candidates: [cand(id, 0.9)], colors: [{ bricklinkColorId: 5, name: 'Red', score: colorScore }],
  boxScore: 0.9, error: null,
});
const OFFLINE: Identification = { status: 'unavailable', candidates: [], colors: [], boxScore: 0, error: 'offline' };

let photoN = 0;
const photo = (w = 1440, h = 1920): ScanFrame => ({ uri: `file:///photo${++photoN}.jpg`, width: w, height: h });
const BOXES = [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, { x: 0.6, y: 0.6, w: 0.2, h: 0.2 }];

/** identifyDetections stand-in: answers every detection with `answer(det)` and lands it through onPiece. */
function answerWith(answer: (d: Detection) => Identification) {
  pipeline.identifyDetections.mockImplementation(async (_f: ScanFrame, dets: Detection[],
    opts: { signal?: AbortSignal; onPiece: (p: IdentifiedPiece) => void }) => {
    const pieces = dets.map((d) => buildPiece(d, answer(d), PAL, `file:///crop-${d.id}.jpg`));
    for (const p of pieces) if (!opts.signal?.aborted) opts.onPiece(p);
    return { pieces, identifyMs: 5, catalogMs: 1, calls: dets.length };
  });
}

function segmented(dets: Detection[], extra: Partial<{ background: string; truncated: boolean; wholeImage: boolean }> = {}) {
  return (p: ScanFrame) => Promise.resolve({ ok: true, value: { frame: p, background: 'plain', detections: dets,
    wholeImage: false, truncated: false, prepareMs: 1, segmentMs: 2, ...extra } });
}
const det = (id: string, x: number, y: number): Detection => ({ id, box: { x, y, w: 0.2, h: 0.2 }, partial: false,
  suspectMerged: false, source: 'segmentation', lab: null, rgb: null });

beforeEach(() => {
  jest.clearAllMocks();
  scanActions.resume();
  scanStore.set({ mode: 'explore', liveOk: true, sessionAdded: {}, lastResult: null });
  pipeline.segmentLive.mockResolvedValue({ ok: true, value: { seg: segResult(BOXES), ms: 3 } });
  answerWith((d) => ident(d.id === 'b' ? '3020' : '3001'));
});

describe('capture', () => {
  it('offline: ends frozen with unavailable pieces and the EX_09 notice, never throws', async () => {
    scanActions.setMode('inventory');
    pipeline.segmentPhoto.mockImplementation(segmented([det('a', 0.1, 0.1), det('b', 0.5, 0.5)]));
    answerWith(() => OFFLINE);
    await expect(scanActions.capture(photo())).resolves.toBeUndefined();
    const s = scanStore.get();
    expect(s.phase).toBe('frozen');
    expect(s.pieces.map((p) => p.identification.status)).toEqual(['unavailable', 'unavailable']);
    expect(s.notice).toBe('identification_unavailable');
    expect(s.lastResult?.pieces).toHaveLength(2);
    expect(s.lastResult?.timings).toMatchObject({ prepareMs: 1, segmentMs: 2, identifyMs: 5, brickognizeCalls: 2 });
  });

  it('a segmentation failure returns to live with a notice', async () => {
    pipeline.segmentPhoto.mockResolvedValue({ ok: false, error: { code: 'unknown', message: 'x' } });
    await scanActions.capture(photo());
    expect(scanStore.get()).toMatchObject({ phase: 'live', frame: null, notice: 'no_piece' });
  });

  it('stores lastResult only in inventory mode; explore writes nothing to lists/items', async () => {
    pipeline.segmentPhoto.mockImplementation(segmented([det('a', 0.1, 0.1)]));
    await scanActions.capture(photo());
    expect(scanStore.get().lastResult).toBeNull();
    expect(scanStore.get().pieces[0].part?.partId).toBe('3001');
    expect(repo.applyDeltas).not.toHaveBeenCalled();
  });

  it('resume() during analysis drops the late segmentation', async () => {
    let finish!: (v: unknown) => void;
    pipeline.segmentPhoto.mockImplementation(() => new Promise((r) => { finish = r; }));
    const p = photo();
    const running = scanActions.capture(p);
    expect(scanStore.get().phase).toBe('analyzing');
    scanActions.resume();
    finish({ ok: true, value: { frame: p, background: 'plain', detections: [det('a', 0.1, 0.1)], wholeImage: false,
      truncated: false, prepareMs: 1, segmentMs: 1 } });
    await running;
    expect(scanStore.get()).toMatchObject({ phase: 'live', pieces: [], frame: null });
    expect(pipeline.identifyDetections).not.toHaveBeenCalled();
  });

  it('resume() during identification drops every later onPiece of the old scan', async () => {
    pipeline.segmentPhoto.mockImplementation(segmented([det('a', 0.1, 0.1), det('b', 0.5, 0.5)]));
    let late!: () => void;
    pipeline.identifyDetections.mockImplementation((_f: ScanFrame, dets: Detection[],
      opts: { onPiece: (p: IdentifiedPiece) => void }) => new Promise((resolve) => {
      late = () => {
        const pieces = dets.map((d) => buildPiece(d, ident('3001'), PAL, `file:///crop-${d.id}.jpg`));
        pieces.forEach(opts.onPiece);                   // ignores the signal on purpose
        resolve({ pieces, identifyMs: 1, catalogMs: 1, calls: 2 });
      };
    }));
    const running = scanActions.capture(photo());
    await flush();
    expect(scanStore.get().phase).toBe('frozen');
    scanActions.resume();
    late();
    await running;
    expect(scanStore.get()).toMatchObject({ phase: 'live', pieces: [] });
    expect(imaging.deleteTempFiles).toHaveBeenCalledWith(['file:///crop-a.jpg']);
  });
});

describe('ingestLiveSnapshot', () => {
  it('unchanged scene: identifies stable tracks once, then zero calls', async () => {
    expect(await scanActions.ingestLiveSnapshot(photo(), VIEW, 256)).toBe('ok');
    expect(pipeline.identifyDetections).not.toHaveBeenCalled();         // seen once
    expect(scanStore.get().pieces).toHaveLength(2);
    expect(await scanActions.ingestLiveSnapshot(photo(), VIEW, 256)).toBe('ok');
    await flush();
    expect(pipeline.identifyDetections).toHaveBeenCalledTimes(1);
    expect(pipeline.identifyDetections.mock.calls[0][1]).toHaveLength(2);
    expect(scanStore.get().pieces.every((p) => p.identification.status === 'identified')).toBe(true);
    for (let i = 0; i < 3; i++) await scanActions.ingestLiveSnapshot(photo(), VIEW, 256);
    await flush();
    expect(pipeline.identifyDetections).toHaveBeenCalledTimes(1);
    expect(scanStore.get().pieces.every((p) => p.identification.status === 'identified')).toBe(true);
  });

  it('deletes the previous snapshot photo, keeps the current one as frame', async () => {
    const p1 = photo();
    const p2 = photo();
    await scanActions.ingestLiveSnapshot(p1, VIEW, 256);
    await scanActions.ingestLiveSnapshot(p2, VIEW, 256);
    await flush();
    expect(scanStore.get().frame).toEqual(p2);
    expect(imaging.deleteTempFiles).toHaveBeenCalledWith([p1.uri]);
    expect(imaging.deleteTempFiles).not.toHaveBeenCalledWith([p2.uri]);
  });

  it('landscape photo with a portrait view → skipped, photo deleted, nothing changed', async () => {
    const before = scanStore.get();
    const p = photo(1920, 1440);
    expect(await scanActions.ingestLiveSnapshot(p, VIEW, 256)).toBe('skipped');
    expect(pipeline.segmentLive).not.toHaveBeenCalled();
    expect(imaging.deleteTempFiles).toHaveBeenCalledWith([p.uri]);
    expect(scanStore.get()).toBe(before);
  });

  it('skipped unless live; failed on a segmentation error', async () => {
    pipeline.segmentLive.mockResolvedValueOnce({ ok: false, error: { code: 'unknown', message: 'x' } });
    expect(await scanActions.ingestLiveSnapshot(photo(), VIEW, 256)).toBe('failed');
    pipeline.segmentLive.mockRejectedValueOnce(new Error('boom'));
    expect(await scanActions.ingestLiveSnapshot(photo(), VIEW, 256)).toBe('failed');
    await scanActions.ingestLiveSnapshot(photo(), VIEW, 256);
    scanActions.freeze();
    expect(await scanActions.ingestLiveSnapshot(photo(), VIEW, 256)).toBe('skipped');
  });

  it('inventory mode only segments', async () => {
    scanActions.setMode('inventory');
    for (let i = 0; i < 3; i++) await scanActions.ingestLiveSnapshot(photo(), VIEW, 256);
    await flush();
    expect(pipeline.identifyDetections).not.toHaveBeenCalled();
    expect(scanStore.get().pieces).toHaveLength(2);
  });

  it('no box → no_piece notice; patterned → skipped', async () => {
    pipeline.segmentLive.mockResolvedValueOnce({ ok: true, value: { seg: segResult([]), ms: 1 } });
    expect(await scanActions.ingestLiveSnapshot(photo(), VIEW, 256)).toBe('ok');
    expect(scanStore.get().notice).toBe('no_piece');
    pipeline.segmentLive.mockResolvedValueOnce({ ok: true, value: { seg: segResult(BOXES, 'patterned'), ms: 1 } });
    expect(await scanActions.ingestLiveSnapshot(photo(), VIEW, 256)).toBe('skipped');
  });
});

describe('freeze and retry', () => {
  it('freeze(id) on a track seen once identifies it', async () => {
    await scanActions.ingestLiveSnapshot(photo(), VIEW, 256);
    const id = scanStore.get().pieces[0].detection.id;
    const scanId = scanStore.get().scanId;
    scanActions.freeze(id);
    expect(scanStore.get()).toMatchObject({ phase: 'frozen', selectedId: id });
    expect(scanStore.get().scanId).not.toBe(scanId);
    await flush();
    expect(pipeline.identifyDetections).toHaveBeenCalledTimes(1);
    expect(pipeline.identifyDetections.mock.calls[0][1].map((d: Detection) => d.id)).toEqual([id]);
    expect(scanStore.get().pieces.find((p) => p.detection.id === id)?.identification.status).toBe('identified');
  });

  it('retryUnavailable re-sends unavailable pieces and pending pieces with nothing in flight', async () => {
    await scanActions.ingestLiveSnapshot(photo(), VIEW, 256);
    const [a, b] = scanStore.get().pieces.map((p) => p.detection.id);
    answerWith(() => OFFLINE);
    scanActions.freeze(a);
    await flush();
    expect(scanStore.get().notice).toBe('identification_unavailable');
    answerWith(() => ident('3001'));
    pipeline.identifyDetections.mockClear();
    await scanActions.retryUnavailable();
    expect(pipeline.identifyDetections.mock.calls[0][1].map((d: Detection) => d.id).sort()).toEqual([a, b].sort());
    expect(scanStore.get().pieces.every((p) => p.identification.status === 'identified')).toBe(true);
    expect(scanStore.get().notice).toBeNull();
  });

  it('addManualBox identifies the new box; removePiece deletes its crop', async () => {
    pipeline.segmentPhoto.mockImplementation(segmented([det('a', 0.1, 0.1)]));
    await scanActions.capture(photo());
    await scanActions.addManualBox({ x: 0.7, y: 0.7 });
    const s = scanStore.get();
    expect(s.pieces).toHaveLength(2);
    expect(s.pieces[1].detection.source).toBe('manual');
    expect(s.pieces[1].identification.status).toBe('identified');
    scanActions.removePiece(s.pieces[1].detection.id);
    expect(scanStore.get().pieces).toHaveLength(1);
    expect(imaging.deleteTempFiles).toHaveBeenCalledWith([s.pieces[1].cropUri]);
  });
});

describe('review', () => {
  async function capturedPile() {
    scanActions.setMode('inventory');
    pipeline.segmentPhoto.mockImplementation(segmented([det('a', 0.1, 0.1), det('a2', 0.3, 0.1), det('b', 0.5, 0.5)]));
    await scanActions.capture(photo());
    scanActions.startReview();
  }

  it('commitReview applies the deltas, updates the session memory, resumes; undo reverts', async () => {
    await capturedPile();
    repo.applyDeltas.mockResolvedValueOnce({
      applied: [{ listId: 'L1', partId: '3001', colorId: 4, delta: 2 }, { listId: 'L1', partId: '3020', colorId: 4, delta: 1 }],
      inverse: [{ listId: 'L1', partId: '3001', colorId: 4, delta: -2 }, { listId: 'L1', partId: '3020', colorId: 4, delta: -1 }],
    });
    const r = await scanActions.commitReview('L1');
    expect(repo.applyDeltas).toHaveBeenCalledWith([
      { listId: 'L1', partId: '3001', colorId: 4, delta: 2 }, { listId: 'L1', partId: '3020', colorId: 4, delta: 1 }]);
    expect(repo.setLastListId).toHaveBeenCalledWith('L1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ added: 3, skipped: 0 });
    expect(scanStore.get()).toMatchObject({ phase: 'live', review: null, pieces: [], sessionAdded: { '3001|4': 2, '3020|4': 1 } });
    repo.applyDeltas.mockResolvedValueOnce({ applied: [], inverse: [] });
    await r.value.undo();
    await r.value.undo();                                         // only once
    expect(repo.applyDeltas).toHaveBeenCalledTimes(2);
    expect(repo.applyDeltas).toHaveBeenLastCalledWith([
      { listId: 'L1', partId: '3001', colorId: 4, delta: -2 }, { listId: 'L1', partId: '3020', colorId: 4, delta: -1 }]);
    expect(scanStore.get().sessionAdded).toEqual({});
  });

  it('commitReview is refused while a colour is to confirm, and without a review', async () => {
    answerWith((d) => ident('3001', d.id === 'b' ? 0.3 : 0.9));
    await capturedPile();
    const r = await scanActions.commitReview('L1');
    expect(r.ok).toBe(false);
    expect(repo.applyDeltas).not.toHaveBeenCalled();
    scanActions.resume();
    expect((await scanActions.commitReview('L1')).ok).toBe(false);
  });

  it('a failing applyDeltas is an err, the review stays open', async () => {
    await capturedPile();
    repo.applyDeltas.mockRejectedValueOnce(new Error('disk'));
    const r = await scanActions.commitReview('L1');
    expect(r.ok).toBe(false);
    expect(scanStore.get().review).not.toBeNull();
  });

  it('chooseCandidate on a line applies to review.pieces only when a review is open', async () => {
    await capturedPile();
    await scanActions.chooseCandidate({ groupKey: 'p:3001|4' }, cand('3062', 0.5));
    const s = scanStore.get();
    expect(reviewLines(s.review!).map((l) => [l.key, l.quantity])).toEqual([['p:3062|4', 2], ['p:3020|4', 1]]);
    expect(s.pieces.every((p) => !p.partConfirmed)).toBe(true);
  });

  it('chooseCandidate without review changes pieces', async () => {
    pipeline.segmentPhoto.mockImplementation(segmented([det('a', 0.1, 0.1)]));
    await scanActions.capture(photo());
    await scanActions.chooseCandidate({ detectionId: 'a' }, cand('3062', 0.5));
    expect(scanStore.get().pieces[0]).toMatchObject({ partConfirmed: true, level: 'accepted' });
    expect(scanStore.get().pieces[0].part?.partId).toBe('3062');
  });
});

describe('misc', () => {
  it('reportLiveFailure', () => {
    scanActions.reportLiveFailure();
    expect(scanStore.get()).toMatchObject({ liveOk: false, notice: 'live_unavailable' });
  });
  it('setMode keeps frame and pieces', async () => {
    await scanActions.ingestLiveSnapshot(photo(), VIEW, 256);
    const { frame, pieces } = scanStore.get();
    scanActions.setMode('inventory');
    expect(scanStore.get()).toMatchObject({ mode: 'inventory', frame, pieces });
  });
});
