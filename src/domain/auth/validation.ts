// Pure auth helpers (WP7, §4.9): field validation, deep-link parsing, supabase-js error mapping.
// No React Native and no supabase import: errors are duck-typed (name / code / status / message).
import type { AppError, AppErrorCode } from '../types';
import { toAppError } from '../result';
import { auth } from '@/i18n/fr/auth';

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[^\s@.]{2,}$/;

/** French error or null. Surrounding spaces are ignored (callers send the trimmed value). */
export function validateEmail(email: string): string | null {
  const v = email.trim();
  if (v === '') return auth.validation.emailRequired;
  return EMAIL_RE.test(v) ? null : auth.validation.emailInvalid;
}

/** ≥ 8 characters (EX_20). */
export function validatePassword(password: string): string | null {
  if (password === '') return auth.validation.passwordRequired;
  return password.length >= 8 ? null : auth.validation.passwordTooShort;
}

/** 6 to 8 digits (the remote OTP length may still be 8 [S]). */
export function validateCode(code: string): string | null {
  const v = code.trim();
  if (v === '') return auth.validation.codeRequired;
  return /^\d{6,8}$/.test(v) ? null : auth.validation.codeInvalid;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

function parseParams(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of s.split('&')) {
    if (pair === '') continue;
    const i = pair.indexOf('=');
    const k = decode(i < 0 ? pair : pair.slice(0, i));
    if (!(k in out)) out[k] = i < 0 ? '' : decode(pair.slice(i + 1));
  }
  return out;
}

/** Tokens from a deep link: fragment (#) first, then query. */
export function parseAuthUrl(url: string): {
  accessToken: string | null;
  refreshToken: string | null;
  type: string | null;
  errorDescription: string | null;
} {
  const hashAt = url.indexOf('#');
  const beforeHash = hashAt < 0 ? url : url.slice(0, hashAt);
  const fragment = parseParams(hashAt < 0 ? '' : url.slice(hashAt + 1));
  const qAt = beforeHash.indexOf('?');
  const query = parseParams(qAt < 0 ? '' : beforeHash.slice(qAt + 1));
  const pick = (k: string): string | null => {
    const v = fragment[k] ?? query[k];
    return v === undefined || v === '' ? null : v;
  };
  return {
    accessToken: pick('access_token'),
    refreshToken: pick('refresh_token'),
    type: pick('type'),
    errorDescription: pick('error_description') ?? pick('error'),
  };
}

export type AuthErrorKind =
  | 'invalid_credentials'
  | 'email_not_confirmed'
  | 'code_invalid'
  | 'weak_password'
  | 'email_rate_limited'
  | 'email_not_authorized'
  | 'other';

type Mapped = AppError & { cause: AuthErrorKind };
const mk = (code: AppErrorCode, message: string, cause: AuthErrorKind): Mapped => ({ code, message, cause });

/** Maps a supabase-js auth error (error.code / status / message) to a French AppError; `cause` carries the kind. */
export function mapAuthError(e: unknown): Mapped {
  const o = (typeof e === 'object' && e !== null ? e : {}) as { name?: unknown; code?: unknown; status?: unknown; message?: unknown };
  const name = typeof o.name === 'string' ? o.name : '';
  const code = typeof o.code === 'string' ? o.code : '';
  const status = typeof o.status === 'number' ? o.status : 0;
  const msg = (typeof o.message === 'string' ? o.message : typeof e === 'string' ? e : '').toLowerCase();

  if (code === 'invalid_credentials' || msg.includes('invalid login credentials')) {
    return mk('invalid', auth.errors.invalidCredentials, 'invalid_credentials');
  }
  if (code === 'email_not_confirmed' || msg.includes('email not confirmed')) {
    return mk('invalid', auth.errors.emailNotConfirmed, 'email_not_confirmed');
  }
  if (code === 'otp_expired' || msg.includes('token has expired or is invalid') || msg.includes('otp has expired')) {
    return mk('invalid', auth.errors.codeInvalid, 'code_invalid');
  }
  if (code === 'weak_password' || name === 'AuthWeakPasswordError' || msg.includes('password should be')) {
    return mk('invalid', auth.errors.weakPassword, 'weak_password');
  }
  if (code === 'over_email_send_rate_limit' || msg.includes('email rate limit')) {
    return mk('rate_limited', auth.errors.emailRateLimited, 'email_rate_limited');
  }
  if (code === 'email_address_not_authorized' || msg.includes('email address not authorized')) {
    return mk('invalid', auth.errors.emailNotAuthorized, 'email_not_authorized');
  }
  if (code === 'same_password') return mk('invalid', auth.errors.samePassword, 'other');
  if (code === 'email_address_invalid') return mk('invalid', auth.validation.emailInvalid, 'other');
  if (name === 'AuthRetryableFetchError') {
    // Network failure inside auth-js (status 0) or a retryable gateway status.
    const base = status >= 500 ? toAppError(e, status) : toAppError(new TypeError('Network request failed'));
    return mk(base.code, base.message, 'other');
  }
  if (name === 'AuthSessionMissingError' || code === 'session_not_found' || code === 'session_expired') {
    const base = toAppError(e, 401);
    return mk(base.code, base.message, 'other');
  }
  const base = status >= 400 ? toAppError(e, status) : toAppError(e);
  return mk(base.code, base.message, 'other');
}
