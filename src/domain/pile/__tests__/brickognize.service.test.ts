// src/services/brickognize.ts with a mocked fetch (D4: retries, budget, never rejects).
import { identifyImage, identifyImageDetailed, predictUrl, resetBrickognizeBudget } from '@/services/brickognize';

const OK_JSON = {
  bounding_box: { left: 0, upper: 0, right: 96, lower: 96, image_width: 192, image_height: 192, score: 0.9 },
  items: [{ id: '3001', name: 'Brick 2 x 4', score: 0.9 }],
  colors: [{ id: '5', name: 'Red', score: 0.9 }],
};

type Res = { status: number; json?: unknown; headers?: Record<string, string> };
const response = ({ status, json, headers = {} }: Res) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  json: async () => json,
});

const fetchMock = jest.fn();
beforeAll(() => { (globalThis as { fetch: unknown }).fetch = fetchMock; });
beforeEach(() => { fetchMock.mockReset(); resetBrickognizeBudget(); jest.spyOn(Math, 'random').mockReturnValue(0); });
afterEach(() => jest.restoreAllMocks());

describe('identifyImage', () => {
  it('posts the documented URL and parses a 200', async () => {
    fetchMock.mockResolvedValueOnce(response({ status: 200, json: OK_JSON }));
    const r = await identifyImageDetailed('file:///crop.jpg');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(predictUrl());
    expect(url).toMatch(/\/predict\/parts\/\?predict_color=true&top_k_items=5&top_k_colors=3&min_similarity_items=0\.25$/);
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect(r.identification.status).toBe('identified');
    expect(r.identification.candidates[0].bricklinkId).toBe('3001');
    expect(r.box).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
  });

  it('retries a 429 after the announced delay, then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ status: 429, headers: { 'x-retry-in': '10ms', 'retry-after': '1' } }))
      .mockResolvedValueOnce(response({ status: 200, json: OK_JSON }));
    const t0 = Date.now();
    const r = await identifyImage('file:///crop.jpg');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(240);   // max(250 ms, 10 ms)
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.status).toBe('identified');
  });

  it('gives up after maxRetries 429 → unavailable / rate_limited', async () => {
    fetchMock.mockResolvedValue(response({ status: 429, headers: { 'x-retry-in': '1ms' } }));
    const r = await identifyImage('file:///crop.jpg');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(r).toMatchObject({ status: 'unavailable', error: 'rate_limited' });
  }, 10000);

  it('network error → one retry, then offline', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));
    const r = await identifyImage('file:///crop.jpg');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ status: 'unavailable', error: 'offline' });
  });

  it.each([[500, 'server'], [503, 'server'], [415, 'server']])('%p → unavailable %p, no retry', async (status, code) => {
    fetchMock.mockResolvedValue(response({ status }));
    const r = await identifyImage('file:///crop.jpg');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ status: 'unavailable', error: code });
  });

  it('malformed JSON body → unavailable / server', async () => {
    fetchMock.mockResolvedValueOnce({ ...response({ status: 200 }), json: async () => { throw new SyntaxError('x'); } });
    expect(await identifyImage('file:///crop.jpg')).toMatchObject({ status: 'unavailable', error: 'server' });
  });

  it('client budget exhausted → unavailable without calling fetch', async () => {
    fetchMock.mockResolvedValue(response({ status: 200, json: OK_JSON }));
    for (let i = 0; i < 90; i++) await identifyImage('file:///crop.jpg');
    fetchMock.mockClear();
    expect(await identifyImage('file:///crop.jpg')).toMatchObject({ status: 'unavailable', error: 'rate_limited' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an aborted signal resolves without a request', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const r = await identifyImage('file:///crop.jpg', ctl.signal);
    expect(r.status).toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
