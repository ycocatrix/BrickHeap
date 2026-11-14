// src/services/imaging.ts with mocked expo-image-manipulator / expo-file-system / upng-js.
const mockManipulate = jest.fn();
const mockDelete = jest.fn();
const mockBytes = jest.fn();
const mockDecode = jest.fn();
const mockToRGBA8 = jest.fn();

jest.mock('expo-image-manipulator', () => ({
  ImageManipulator: { manipulate: (...a: unknown[]) => mockManipulate(...a) },
  SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
}));
jest.mock('expo-file-system', () => ({
  File: class {
    uri: string;
    constructor(uri: string) { this.uri = uri; }
    get exists() { return true; }
    delete() { mockDelete(this.uri); }
    bytes() { return mockBytes(this.uri); }
  },
}));
jest.mock('upng-js', () => ({ decode: (b: unknown) => mockDecode(b), toRGBA8: (i: unknown) => mockToRGBA8(i) }));
jest.mock('@/domain/vision/geometry', () => ({
  boxToPixelRect: (b: { x: number; y: number; w: number; h: number }, s: { width: number; height: number }) => ({
    originX: Math.round(b.x * s.width), originY: Math.round(b.y * s.height),
    width: Math.max(1, Math.round(b.w * s.width)), height: Math.max(1, Math.round(b.h * s.height)) }),
}));

// eslint-disable-next-line import/first
import { cropForIdentification, deleteTempFiles, prepareWorkImage, readThumbnailRgba } from '@/services/imaging';
// eslint-disable-next-line import/first
import { scan } from '@/i18n/fr/scan';

/** A fake manipulator context recording the scheduled operations. */
interface FakeContext {
  ops: unknown[];
  ref: { saveAsync: jest.Mock; release: jest.Mock };
  resize: jest.Mock;
  crop: jest.Mock;
  renderAsync: jest.Mock;
  release: jest.Mock;
}
function fakeContext(out: { uri: string; width: number; height: number }): FakeContext {
  const ops: unknown[] = [];
  const ref = { saveAsync: jest.fn(async () => out), release: jest.fn() };
  const ctx: FakeContext = {
    ops,
    ref,
    resize: jest.fn((s: unknown): FakeContext => { ops.push(['resize', s]); return ctx; }),
    crop: jest.fn((r: unknown): FakeContext => { ops.push(['crop', r]); return ctx; }),
    renderAsync: jest.fn(async () => ref),
    release: jest.fn(),
  };
  return ctx;
}

beforeEach(() => jest.clearAllMocks());

describe('prepareWorkImage', () => {
  it('does not re-encode a photo whose long side ≤ 1920', async () => {
    const photo = { uri: 'file:///p.jpg', width: 1920, height: 1440 };
    const r = await prepareWorkImage(photo, 1920);
    expect(r).toEqual({ ok: true, value: photo });
    expect(mockManipulate).not.toHaveBeenCalled();
  });
  it('resizes a larger photo with ONE context to JPEG 0.85', async () => {
    const ctx = fakeContext({ uri: 'file:///w.jpg', width: 1920, height: 1440 });
    mockManipulate.mockReturnValue(ctx);
    const r = await prepareWorkImage({ uri: 'file:///p.jpg', width: 4032, height: 3024 }, 1920);
    expect(mockManipulate).toHaveBeenCalledTimes(1);
    expect(ctx.ops).toEqual([['resize', { width: 1920 }]]);
    expect(ctx.ref.saveAsync).toHaveBeenCalledWith({ format: 'jpeg', compress: 0.85 });
    expect(r).toEqual({ ok: true, value: { uri: 'file:///w.jpg', width: 1920, height: 1440 } });
  });
  it('never rejects', async () => {
    mockManipulate.mockImplementation(() => { throw new Error('boom'); });
    const r = await prepareWorkImage({ uri: 'file:///p.jpg', width: 3000, height: 4000 }, 1920);
    expect(r.ok).toBe(false);
  });
});

describe('readThumbnailRgba', () => {
  it('renders a PNG, decodes it and deletes it', async () => {
    const ctx = fakeContext({ uri: 'file:///t.png', width: 4, height: 3 });
    mockManipulate.mockReturnValue(ctx);
    const bytes = new Uint8Array([1, 2, 3]);
    mockBytes.mockResolvedValue(bytes);
    mockDecode.mockReturnValue({ width: 4, height: 3 });
    mockToRGBA8.mockReturnValue([new ArrayBuffer(4 * 3 * 4)]);
    const r = await readThumbnailRgba({ uri: 'file:///p.jpg', width: 1440, height: 1920 }, 320);
    expect(ctx.ops).toEqual([['resize', { height: 320 }]]);
    expect(ctx.ref.saveAsync).toHaveBeenCalledWith({ format: 'png' });
    expect(mockDecode).toHaveBeenCalledWith(bytes);                // the Uint8Array itself, not its .buffer
    expect(r.ok && r.value.width === 4 && r.value.height === 3 && r.value.rgba.length === 48).toBe(true);
    expect(mockDelete).toHaveBeenCalledWith('file:///t.png');
  });
  it('a decode error is err("unknown"), never a throw', async () => {
    mockManipulate.mockReturnValue(fakeContext({ uri: 'file:///t.png', width: 4, height: 3 }));
    mockBytes.mockResolvedValue(new Uint8Array());
    mockDecode.mockImplementation(() => { throw new Error('corrupt'); });
    const r = await readThumbnailRgba({ uri: 'file:///p.jpg', width: 100, height: 100 }, 320);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('unknown');
    expect(mockDelete).toHaveBeenCalledWith('file:///t.png');
  });
});

describe('cropForIdentification', () => {
  const frame = { uri: 'file:///p.jpg', width: 1000, height: 1000 };
  it('crops then resizes the long side to 320, JPEG 0.8', async () => {
    const ctx = fakeContext({ uri: 'file:///c.jpg', width: 320, height: 160 });
    mockManipulate.mockReturnValue(ctx);
    const r = await cropForIdentification(frame, { x: 0.1, y: 0.2, w: 0.2, h: 0.1 });
    expect(ctx.ops).toEqual([['crop', { originX: 100, originY: 200, width: 200, height: 100 }], ['resize', { width: 320 }]]);
    expect(ctx.ref.saveAsync).toHaveBeenCalledWith({ format: 'jpeg', compress: 0.8 });
    expect(r).toEqual({ ok: true, value: { uri: 'file:///c.jpg' } });
  });
  it('too small → err invalid with the tooSmall message', async () => {
    const r = await cropForIdentification(frame, { x: 0.1, y: 0.1, w: 0.03, h: 0.03 });
    expect(r).toEqual({ ok: false, error: { code: 'invalid', message: scan.tooSmall } });
    expect(mockManipulate).not.toHaveBeenCalled();
  });
});

describe('deleteTempFiles', () => {
  it('deletes each distinct uri and never rejects', async () => {
    mockDelete.mockImplementationOnce(() => { throw new Error('gone'); });
    await expect(deleteTempFiles(['file:///a', 'file:///a', 'file:///b', ''])).resolves.toBeUndefined();
    expect(mockDelete.mock.calls.map((c) => c[0])).toEqual(['file:///a', 'file:///b']);
  });
});
