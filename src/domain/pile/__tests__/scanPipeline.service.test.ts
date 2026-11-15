// src/services/scanPipeline.ts with mocked imaging / brickognize / catalogue and WP2 stand-ins.
import type { Detection, Identification, IdentifiedPiece } from '@/domain/types';
import { identifyDetections, segmentPhoto } from '@/services/scanPipeline';
import { groupPieces } from '@/domain/pile/grouping';
import { cand, detection, segResult } from '../testing/fixtures';

const mockIdentify = jest.fn();
const mockResolve = jest.fn();
const mockSegment = jest.fn();

jest.mock('@/services/imaging', () => ({
  prepareWorkImage: jest.fn(),
  readThumbnailRgba: jest.fn(),
  cropForIdentification: jest.fn(),
  wholeForIdentification: jest.fn(),
  deleteTempFiles: jest.fn(async () => undefined),
}));
jest.mock('@/services/brickognize', () => ({ identifyImageDetailed: (...a: unknown[]) => mockIdentify(...a) }));
jest.mock('@/services/catalog', () => ({
  getPalette: async () => jest.requireActual('../testing/fixtures').palette(
    [jest.requireActual('../testing/fixtures').color(4, 5), jest.requireActual('../testing/fixtures').color(0, 11)]),
  resolveCandidates: (...a: unknown[]) => mockResolve(...a),
}));
jest.mock('@/domain/catalog/partInfo', () => jest.requireActual('../testing/fixtures').partInfoMock);
jest.mock('@/domain/vision/color', () => ({ COMMON_OPAQUE_COLOR_IDS: [0, 4], nearestColors: () => [] }));
jest.mock('@/domain/vision/detections', () => jest.requireActual('../testing/fixtures').visionMock.detections);
jest.mock('@/domain/vision/segment', () => ({ segmentPileAsync: (...a: unknown[]) => mockSegment(...a) }));

const mockImaging = jest.requireMock('@/services/imaging') as Record<
  'prepareWorkImage' | 'readThumbnailRgba' | 'cropForIdentification' | 'wholeForIdentification' | 'deleteTempFiles', jest.Mock>;

const FRAME = { uri: 'file:///frame.jpg', width: 1600, height: 1200 };
const identified = (id: string, score = 0.9, colorScore = 0.9): Identification => ({
  status: 'identified', candidates: [cand(id, score)], colors: [{ bricklinkColorId: 5, name: 'Red', score: colorScore }],
  boxScore: 0.9, error: null,
});
const unavailable: Identification = { status: 'unavailable', candidates: [], colors: [], boxScore: 0, error: 'offline' };
const provisional = (id: string, resolution: 'pending' | 'not_found' = 'pending') =>
  jest.requireActual('../testing/fixtures').partInfoMock.provisionalPart({ bricklinkId: id, name: `Part ${id}`, imageUrl: null }, resolution);

let cropN = 0;
beforeEach(() => {
  jest.clearAllMocks();
  cropN = 0;
  mockImaging.cropForIdentification.mockImplementation(async () => ({ ok: true, value: { uri: `file:///crop${++cropN}.jpg` } }));
  mockImaging.wholeForIdentification.mockImplementation(async () => ({ ok: true, value: { uri: 'file:///whole.jpg' } }));
});

const dets = (n: number): Detection[] => Array.from({ length: n }, (_, i) => detection(`d${i}`, 0.1 * i, 0.1));

describe('identifyDetections', () => {
  it('proxy unreachable: every identified piece keeps a provisional part and an ok group', async () => {
    mockIdentify.mockImplementation(async () => ({ identification: identified('3001'), box: null }));
    const { partInfoMock } = jest.requireActual('../testing/fixtures');
    mockResolve.mockImplementation(async (cs: { bricklinkId: string; name: string; imageUrl: string | null }[]) =>
      new Map(cs.map((c) => [c.bricklinkId, partInfoMock.provisionalPart(c, 'pending')])));
    const seen: IdentifiedPiece[] = [];
    const out = await identifyDetections(FRAME, dets(3), { onPiece: (p) => seen.push(p) });
    expect(out.calls).toBe(3);
    expect(out.pieces).toHaveLength(3);
    expect(seen).toHaveLength(3);                          // provisional = same part → no second onPiece
    expect(mockResolve).toHaveBeenCalledTimes(1);          // ONE batched call for distinct candidates
    expect(mockResolve.mock.calls[0][0]).toHaveLength(1);
    for (const p of out.pieces) {
      expect(p.part).toMatchObject({ partId: '3001', source: 'brickognize', resolution: 'pending' });
      expect(p.cropUri).toMatch(/^file:\/\/\/crop/);
      expect(p.color).toMatchObject({ colorId: 4, reliable: true });
    }
    expect(groupPieces(out.pieces).map((g) => [g.kind, g.count])).toEqual([['ok', 3]]);
  });

  it('resolveCandidates rejecting still leaves provisional parts', async () => {
    mockIdentify.mockImplementation(async () => ({ identification: identified('3062', 0.9, 0.6), box: null }));
    mockResolve.mockRejectedValue(new Error('down'));
    const out = await identifyDetections(FRAME, dets(2), { onPiece: () => undefined });
    expect(out.pieces.every((p) => p.part?.partId === '3062')).toBe(true);
    expect(groupPieces(out.pieces).map((g) => g.kind)).toEqual(['color_to_confirm']);
  });

  it('a resolved part is swapped in with a second onPiece', async () => {
    mockIdentify.mockImplementation(async () => ({ identification: identified('3062'), box: null }));
    mockResolve.mockResolvedValue(new Map([['3062', { ...provisional('3062b'), source: 'rebrickable', resolution: 'resolved' }]]));
    const seen: IdentifiedPiece[] = [];
    const out = await identifyDetections(FRAME, dets(1), { onPiece: (p) => seen.push(p) });
    expect(seen.map((p) => p.part?.partId)).toEqual(['3062', '3062b']);
    expect(out.pieces[0].part?.source).toBe('rebrickable');
  });

  it('unavailable identifications are kept (EX_09)', async () => {
    mockIdentify.mockResolvedValue({ identification: unavailable, box: null });
    const out = await identifyDetections(FRAME, dets(2), { onPiece: () => undefined });
    expect(out.pieces.map((p) => [p.identification.status, p.level, p.part])).toEqual(
      [['unavailable', 'unknown', null], ['unavailable', 'unknown', null]]);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('a too-small crop → empty with error invalid, no request', async () => {
    mockImaging.cropForIdentification.mockResolvedValue({ ok: false, error: { code: 'invalid', message: 'x' } });
    const out = await identifyDetections(FRAME, dets(1), { onPiece: () => undefined });
    expect(out.calls).toBe(0);
    expect(out.pieces[0].identification).toMatchObject({ status: 'empty', error: 'invalid' });
    expect(mockIdentify).not.toHaveBeenCalled();
  });

  it('whole-image detection takes Brickognize\'s box when boxScore ≥ 0.5', async () => {
    mockIdentify.mockResolvedValue({ identification: identified('3001'), box: { x: 0.2, y: 0.2, w: 0.5, h: 0.4 } });
    mockResolve.mockResolvedValue(new Map());
    const whole: Detection = { ...detection('w', 0, 0), box: { x: 0, y: 0, w: 1, h: 1 }, source: 'whole_image' };
    const out = await identifyDetections(FRAME, [whole], { onPiece: () => undefined });
    expect(mockImaging.wholeForIdentification).toHaveBeenCalled();
    expect(out.pieces[0].detection.box).toEqual({ x: 0.2, y: 0.2, w: 0.5, h: 0.4 });
  });

  it('uses a pool of 4', async () => {
    let active = 0;
    let peak = 0;
    mockIdentify.mockImplementation(async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return { identification: identified('3001'), box: null };
    });
    mockResolve.mockResolvedValue(new Map());
    await identifyDetections(FRAME, dets(10), { onPiece: () => undefined });
    expect(peak).toBe(4);
  });

  it('after abort no onPiece is called', async () => {
    const ctl = new AbortController();
    let n = 0;
    mockIdentify.mockImplementation(async () => {
      n += 1;
      if (n === 2) ctl.abort();
      return { identification: identified('3001'), box: null };
    });
    mockResolve.mockResolvedValue(new Map());
    const seen: string[] = [];
    await identifyDetections(FRAME, dets(8), { signal: ctl.signal, onPiece: (p) => seen.push(p.detection.id) });
    expect(seen.length).toBeLessThanOrEqual(1);
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockImaging.deleteTempFiles).toHaveBeenCalled();       // crops of dropped answers are deleted
  });
});

describe('segmentPhoto', () => {
  let id = 0;
  const newId = () => `n${++id}`;
  beforeEach(() => {
    mockImaging.prepareWorkImage.mockImplementation(async (p: unknown) => ({ ok: true, value: p }));
    mockImaging.readThumbnailRgba.mockResolvedValue({ ok: true, value: { rgba: new Uint8Array(16 * 16 * 4), width: 16, height: 16 } });
  });
  it('maps boxes to detections', async () => {
    mockSegment.mockResolvedValue(segResult([{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }]));
    const r = await segmentPhoto(FRAME, newId);
    expect(r.ok && r.value.detections.length === 2 && !r.value.wholeImage && r.value.background === 'plain').toBe(true);
    expect(mockImaging.prepareWorkImage).toHaveBeenCalledWith(FRAME, 1920);
    expect(mockImaging.readThumbnailRgba).toHaveBeenCalledWith(FRAME, 320);
  });
  it('patterned background or no box → one whole-image detection', async () => {
    mockSegment.mockResolvedValue(segResult([{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }], 'patterned'));
    const r1 = await segmentPhoto(FRAME, newId);
    expect(r1.ok && r1.value.wholeImage && r1.value.detections[0].source === 'whole_image').toBe(true);
    mockSegment.mockResolvedValue(segResult([]));
    const r2 = await segmentPhoto(FRAME, newId);
    expect(r2.ok && r2.value.wholeImage && r2.value.detections.length === 1).toBe(true);
  });
  it('a segmentation throw is an err, never a rejection', async () => {
    mockSegment.mockRejectedValue(new RangeError('too small'));
    const r = await segmentPhoto(FRAME, newId);
    expect(r.ok).toBe(false);
  });
  it('deletes a re-encoded work image when aborted', async () => {
    mockImaging.prepareWorkImage.mockResolvedValue({ ok: true, value: { uri: 'file:///work.jpg', width: 1920, height: 1440 } });
    const ctl = new AbortController();
    ctl.abort();
    const r = await segmentPhoto({ uri: 'file:///big.jpg', width: 4000, height: 3000 }, newId, ctl.signal);
    expect(r.ok).toBe(false);
    expect(mockImaging.deleteTempFiles).toHaveBeenCalledWith(['file:///work.jpg']);
  });
});
