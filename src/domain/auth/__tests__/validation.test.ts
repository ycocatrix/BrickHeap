import { mapAuthError, parseAuthUrl, validateCode, validateEmail, validatePassword } from '../validation';
import { auth } from '@/i18n/fr/auth';
import { common } from '@/i18n/fr/common';

describe('validateEmail', () => {
  it('accepts a valid address (surrounding spaces ignored)', () => {
    expect(validateEmail('yann@exemple.fr')).toBeNull();
    expect(validateEmail('  a.b+c@sub.domaine.com ')).toBeNull();
  });
  it('rejects a missing TLD', () => {
    expect(validateEmail('yann@exemple')).toBe(auth.validation.emailInvalid);
    expect(validateEmail('yann@exemple.f')).toBe(auth.validation.emailInvalid);
  });
  it('rejects inner spaces and empty values', () => {
    expect(validateEmail('ya nn@exemple.fr')).toBe(auth.validation.emailInvalid);
    expect(validateEmail('yann@exe mple.fr')).toBe(auth.validation.emailInvalid);
    expect(validateEmail('   ')).toBe(auth.validation.emailRequired);
  });
});

describe('validatePassword', () => {
  it('requires 8 characters', () => {
    expect(validatePassword('1234567')).toBe(auth.validation.passwordTooShort);
    expect(validatePassword('12345678')).toBeNull();
    expect(validatePassword('')).toBe(auth.validation.passwordRequired);
  });
});

describe('validateCode', () => {
  it('accepts 6 to 8 digits only', () => {
    expect(validateCode('12345')).toBe(auth.validation.codeInvalid);
    expect(validateCode('123456')).toBeNull();
    expect(validateCode(' 12345678 ')).toBeNull();
    expect(validateCode('123456789')).toBe(auth.validation.codeInvalid);
    expect(validateCode('12a456')).toBe(auth.validation.codeInvalid);
    expect(validateCode('')).toBe(auth.validation.codeRequired);
  });
});

describe('parseAuthUrl', () => {
  it('reads tokens from the fragment', () => {
    const r = parseAuthUrl('brickheap://auth/callback#access_token=abc&refresh_token=def&type=recovery&expires_in=3600');
    expect(r).toEqual({ accessToken: 'abc', refreshToken: 'def', type: 'recovery', errorDescription: null });
  });
  it('reads tokens from the query when there is no fragment', () => {
    const r = parseAuthUrl('exp://192.168.1.2:8081/--/auth/callback?access_token=a%2Fb&refresh_token=r&type=signup');
    expect(r).toEqual({ accessToken: 'a/b', refreshToken: 'r', type: 'signup', errorDescription: null });
  });
  it('prefers the fragment over the query', () => {
    const r = parseAuthUrl('brickheap://auth/callback?type=signup#type=recovery&access_token=x&refresh_token=y');
    expect(r.type).toBe('recovery');
  });
  it('reads error_description', () => {
    const r = parseAuthUrl(
      'brickheap://auth/callback#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
    );
    expect(r.errorDescription).toBe('Email link is invalid or has expired');
    expect(r.accessToken).toBeNull();
  });
  it('returns nulls when the URL has no token', () => {
    expect(parseAuthUrl('brickheap://auth/callback')).toEqual({
      accessToken: null,
      refreshToken: null,
      type: null,
      errorDescription: null,
    });
  });
});

describe('mapAuthError', () => {
  const apiError = (code: string, status: number, message: string) =>
    Object.assign(new Error(message), { name: 'AuthApiError', code, status });

  it('invalid_credentials', () => {
    const e = mapAuthError(apiError('invalid_credentials', 400, 'Invalid login credentials'));
    expect(e).toMatchObject({ code: 'invalid', cause: 'invalid_credentials', message: auth.errors.invalidCredentials });
  });
  it('email_not_confirmed', () => {
    expect(mapAuthError(apiError('email_not_confirmed', 400, 'Email not confirmed')).cause).toBe('email_not_confirmed');
  });
  it('otp_expired → code_invalid', () => {
    const e = mapAuthError(apiError('otp_expired', 403, 'Token has expired or is invalid'));
    expect(e).toMatchObject({ code: 'invalid', cause: 'code_invalid' });
  });
  it('over_email_send_rate_limit', () => {
    const e = mapAuthError(apiError('over_email_send_rate_limit', 429, 'Email rate limit exceeded'));
    expect(e).toMatchObject({ code: 'rate_limited', cause: 'email_rate_limited', message: auth.errors.emailRateLimited });
  });
  it('weak_password (also by error name)', () => {
    expect(mapAuthError(apiError('weak_password', 422, 'Password should be at least 8 characters.')).cause).toBe('weak_password');
    expect(mapAuthError(Object.assign(new Error('weak'), { name: 'AuthWeakPasswordError' })).cause).toBe('weak_password');
  });
  it('"Email address not authorized" without a code', () => {
    const e = mapAuthError({ message: 'Email address not authorized', status: 400 });
    expect(e).toMatchObject({ cause: 'email_not_authorized', message: auth.errors.emailNotAuthorized });
  });
  it('a network TypeError → offline', () => {
    const e = mapAuthError(new TypeError('Network request failed'));
    expect(e).toMatchObject({ code: 'offline', cause: 'other', message: common.errors.offline });
  });
  it('AuthRetryableFetchError with status 0 → offline', () => {
    const e = mapAuthError(Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError', status: 0 }));
    expect(e.code).toBe('offline');
  });
  it('an unknown error → unknown, generic message', () => {
    const e = mapAuthError(new Error('something odd'));
    expect(e).toMatchObject({ code: 'unknown', cause: 'other', message: common.errors.unknown });
    expect(mapAuthError(undefined).code).toBe('unknown');
  });
  it('HTTP status of an unrecognised API error', () => {
    expect(mapAuthError(apiError('unexpected_failure', 500, 'boom')).code).toBe('server');
    expect(mapAuthError(apiError('over_request_rate_limit', 429, 'Too many')).code).toBe('rate_limited');
  });
});
