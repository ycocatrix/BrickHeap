// The only file that knows the Brickognize HTTP API (D4). Never rejects.
import type { AppErrorCode, BoundingBox, Identification } from '@/domain/types';
import { parseBoundingBox, parseBrickognizeResponse, retryDelayMs } from '@/domain/pile/brickognizeParse';
import { VISION } from '@/domain/vision/config';
import { env } from './env';

const CFG = VISION.brickognize;
const MIN_RETRY_MS = 250;
const JITTER_MS = 250;
const WINDOW_MS = 60_000;

/** Timestamps of the requests sent during the last minute (client budget, D4). */
const sent: number[] = [];

function takeBudget(now = Date.now()): boolean {
  while (sent.length > 0 && now - sent[0] >= WINDOW_MS) sent.shift();
  if (sent.length >= CFG.budgetPerMinute) return false;
  sent.push(now);
  return true;
}

/** Test hook: forgets the budget window. */
export function resetBrickognizeBudget(): void {
  sent.length = 0;
}

export function predictUrl(): string {
  const base = env.brickognizeUrl.replace(/\/+$/, '');
  return `${base}/predict/parts/?predict_color=true&top_k_items=${CFG.topKItems}`
    + `&top_k_colors=${CFG.topKColors}&min_similarity_items=${CFG.minSimilarity}`;
}

const unavailable = (error: AppErrorCode): Identification =>
  ({ status: 'unavailable', candidates: [], colors: [], boxScore: 0, error });

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done);
  });
}

type Attempt =
  | { kind: 'response'; status: number; json: unknown; headers: { get(name: string): string | null } }
  | { kind: 'network' } | { kind: 'timeout' } | { kind: 'aborted' } | { kind: 'malformed' };

async function attempt(uri: string, signal?: AbortSignal): Promise<Attempt> {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, CFG.timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const form = new FormData();
    // React Native multipart file part: { uri, name, type }.
    form.append('query_image', { uri, name: 'crop.jpg', type: 'image/jpeg' } as unknown as Blob);
    const res = await fetch(predictUrl(), {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: form,
      signal: ctl.signal,
    });
    let json: unknown = null;
    if (res.ok) {
      try {
        json = await res.json();
      } catch {
        return { kind: 'malformed' };
      }
    }
    return { kind: 'response', status: res.status, json, headers: res.headers };
  } catch {
    if (signal?.aborted) return { kind: 'aborted' };
    return timedOut ? { kind: 'timeout' } : { kind: 'network' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export interface DetailedIdentification {
  identification: Identification;
  /** Brickognize's bounding box, normalised to the sent image; null when absent. */
  box: BoundingBox | null;
}

/** identifyImage plus Brickognize's normalised bounding box (used for whole-image detections). Never rejects.
 *  429 → wait max(250 ms, x-retry-in | retry-after) + jitter, up to maxRetries; network error → one retry;
 *  budget exhausted, timeout, 5xx, 415 or retries exhausted → { status: 'unavailable', error }. */
export async function identifyImageDetailed(uri: string, signal?: AbortSignal): Promise<DetailedIdentification> {
  let rateRetries = 0;
  let networkRetries = 0;
  try {
    for (;;) {
      if (signal?.aborted) return { identification: unavailable('unknown'), box: null };
      if (!takeBudget()) return { identification: unavailable('rate_limited'), box: null };
      const a = await attempt(uri, signal);
      switch (a.kind) {
        case 'aborted': return { identification: unavailable('unknown'), box: null };
        case 'timeout': return { identification: unavailable('timeout'), box: null };
        case 'malformed': return { identification: unavailable('server'), box: null };
        case 'network':
          if (networkRetries < 1) { networkRetries += 1; continue; }
          return { identification: unavailable('offline'), box: null };
        case 'response': {
          if (a.status >= 200 && a.status < 300) {
            return { identification: parseBrickognizeResponse(a.json), box: parseBoundingBox(a.json) };
          }
          if (a.status === 429) {
            if (rateRetries >= CFG.maxRetries) return { identification: unavailable('rate_limited'), box: null };
            rateRetries += 1;
            const announced = retryDelayMs(a.headers.get('x-retry-in'), a.headers.get('retry-after')) ?? 0;
            await sleep(Math.max(MIN_RETRY_MS, announced) + Math.random() * JITTER_MS, signal);
            continue;
          }
          if (a.status === 401 || a.status === 403) return { identification: unavailable('unauthorized'), box: null };
          return { identification: unavailable(a.status >= 500 || a.status === 415 ? 'server' : 'unknown'), box: null };
        }
      }
    }
  } catch {
    return { identification: unavailable('unknown'), box: null };
  }
}

/** POST {env.brickognizeUrl}/predict/parts/?predict_color=true&top_k_items=5&top_k_colors=3&min_similarity_items=0.25
 *  multipart field `query_image` (image/jpeg). Never rejects. */
export async function identifyImage(uri: string, signal?: AbortSignal): Promise<Identification> {
  return (await identifyImageDetailed(uri, signal)).identification;
}
