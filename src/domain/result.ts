import type { AppError, AppErrorCode, Result } from './types';
import { common } from '@/i18n/fr/common';

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const err = (code: AppErrorCode, message: string, cause?: unknown): Result<never> => ({
  ok: false,
  error: cause === undefined ? { code, message } : { code, message, cause },
});

/** Used by WP0 stubs only: every call must be gone once the owning package has implemented its file. */
export function notImplemented(what?: string): never {
  throw new Error(what ? `Not implemented: ${what}` : 'Not implemented');
}

const CODES: readonly AppErrorCode[] = [
  'offline', 'timeout', 'rate_limited', 'server', 'not_configured', 'unauthorized', 'invalid', 'not_found', 'unknown',
];

function isAppError(e: unknown): e is AppError {
  if (typeof e !== 'object' || e === null) return false;
  const o = e as { code?: unknown; message?: unknown };
  return typeof o.message === 'string' && typeof o.code === 'string' && (CODES as readonly string[]).includes(o.code);
}

function codeForStatus(status: number): AppErrorCode {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'unknown';
}

function make(code: AppErrorCode, cause: unknown): AppError {
  return cause === undefined ? { code, message: common.errors[code] } : { code, message: common.errors[code], cause };
}

/** Maps a thrown value / fetch failure / HTTP status to an AppError with the French message from common.errors.
 *  TypeError('Network request failed') → offline · AbortError / TimeoutError → timeout · 401,403 → unauthorized ·
 *  404 → not_found · 429 → rate_limited · ≥ 500 → server · else unknown. An AppError is returned unchanged. */
export function toAppError(e: unknown, httpStatus?: number): AppError {
  if (httpStatus !== undefined) return make(codeForStatus(httpStatus), e);
  if (isAppError(e)) return e;
  if (typeof e === 'object' && e !== null) {
    const o = e as { name?: unknown; message?: unknown; status?: unknown };
    if (o.name === 'AbortError' || o.name === 'TimeoutError') return make('timeout', e);
    if (e instanceof TypeError) {
      const msg = typeof o.message === 'string' ? o.message : '';
      if (/network|fetch|load failed/i.test(msg)) return make('offline', e);
    }
    if (typeof o.status === 'number' && o.status >= 400) return make(codeForStatus(o.status), e);
  }
  return make('unknown', e);
}
