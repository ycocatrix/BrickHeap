// Auth service (WP7, §4.9, D12). Every function returns err('not_configured') when supabase is null; none rejects.
// Passwords and tokens are never logged, persisted, or put in route params: the only copy kept is the in-memory
// sign-up credentials used by confirmedViaLink(), cleared on success or sign-out.
import * as Linking from 'expo-linking';
import type { AuthError } from '@supabase/supabase-js';
import type { AppError, Result } from '@/domain/types';
import { err, ok, toAppError } from '@/domain/result';
import { mapAuthError, parseAuthUrl } from '@/domain/auth/validation';
import { common } from '@/i18n/fr/common';
import { auth } from '@/i18n/fr/auth';
import type { CodePurpose } from '@/navigation/routes';
import { supabase } from './supabase';
import { syncNow, syncStore, wipeLocalUserData } from './sync';
import { leaveApp, sessionStore } from '@/state/session';

let signupCredentials: { email: string; password: string } | null = null;

const notConfigured = (): Result<never> => err('not_configured', common.errors.not_configured);

function redirectTo(): string | undefined {
  try {
    return Linking.createURL('auth/callback');
  } catch {
    return undefined;
  }
}

const fail = (e: unknown): Result<never> => {
  const m = mapAuthError(e);
  return { ok: false, error: m };
};

/** Errors that may surface from "no enumeration" endpoints: the network, rate limits and e-mail delivery limits
 *  say nothing about whether the account exists. Everything else is reported as success. */
function surfacesWithoutEnumeration(e: AppError & { cause: string }): boolean {
  return (
    e.code === 'offline' ||
    e.code === 'timeout' ||
    e.code === 'rate_limited' ||
    e.code === 'server' ||
    e.cause === 'email_rate_limited' ||
    e.cause === 'email_not_authorized'
  );
}

async function guard<T>(run: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await run();
  } catch (e) {
    return fail(e);
  }
}

/** EX_21. data = { pseudo, cgu_accepted_at }. needsCode = no session returned (e-mail confirmation on).
 *  An already-registered e-mail yields the same result (no enumeration). */
export function signUp(input: { email: string; password: string; pseudo?: string }): Promise<Result<{ needsCode: boolean }>> {
  const client = supabase;
  if (!client) return Promise.resolve(notConfigured());
  return guard<{ needsCode: boolean }>(async () => {
    const email = input.email.trim();
    const pseudo = input.pseudo?.trim() ? input.pseudo.trim() : null;
    const { data, error } = await client.auth.signUp({
      email,
      password: input.password,
      options: { emailRedirectTo: redirectTo(), data: { pseudo, cgu_accepted_at: new Date().toISOString() } },
    });
    if (error) {
      const code = (error as AuthError).code;
      if (code === 'user_already_exists' || code === 'email_exists') {
        signupCredentials = { email, password: input.password };
        return ok({ needsCode: true });
      }
      return fail(error);
    }
    if (data.session) {
      signupCredentials = null;
      return ok({ needsCode: false });
    }
    signupCredentials = { email, password: input.password };
    return ok({ needsCode: true });
  });
}

/** verifyOtp. 'signup' → type 'email' then, if refused, 'signup'; 'login' → 'email'; 'recovery' → 'recovery'. */
export function verifyCode(input: { email: string; code: string; purpose: CodePurpose }): Promise<Result<void>> {
  const client = supabase;
  if (!client) return Promise.resolve(notConfigured());
  return guard(async () => {
    const email = input.email.trim();
    const token = input.code.trim();
    const type = input.purpose === 'recovery' ? 'recovery' : 'email';
    let { error } = await client.auth.verifyOtp({ email, token, type });
    if (error && input.purpose === 'signup') {
      const first = mapAuthError(error);
      if (first.code === 'invalid') ({ error } = await client.auth.verifyOtp({ email, token, type: 'signup' }));
    }
    if (error) return fail(error);
    signupCredentials = null;
    return ok(undefined);
  });
}

export function resendCode(email: string, purpose: CodePurpose): Promise<Result<void>> {
  const client = supabase;
  if (!client) return Promise.resolve(notConfigured());
  if (purpose === 'login') return requestLoginCode(email);
  if (purpose === 'recovery') return requestPasswordReset(email);
  return guard(async () => {
    const { error } = await client.auth.resend({
      type: 'signup',
      email: email.trim(),
      options: { emailRedirectTo: redirectTo() },
    });
    if (error) {
      const m = mapAuthError(error);
      return surfacesWithoutEnumeration(m) ? fail(error) : ok(undefined);
    }
    return ok(undefined);
  });
}

/** Sign-up fallback when the e-mail only contains a link (default template): signs in with the in-memory credentials. */
export function confirmedViaLink(): Promise<Result<void>> {
  const client = supabase;
  if (!client) return Promise.resolve(notConfigured());
  const creds = signupCredentials;
  if (!creds) return Promise.resolve(err('invalid', auth.errors.linkNoCredentials));
  return guard(async () => {
    const { error } = await client.auth.signInWithPassword({ email: creds.email, password: creds.password });
    if (error) {
      const m = mapAuthError(error);
      if (m.cause === 'email_not_confirmed') return err('invalid', auth.errors.notConfirmedYet, 'email_not_confirmed');
      return { ok: false, error: m };
    }
    signupCredentials = null;
    return ok(undefined);
  });
}

export function signInWithPassword(email: string, password: string): Promise<Result<void>> {
  const client = supabase;
  if (!client) return Promise.resolve(notConfigured());
  return guard(async () => {
    const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
    return error ? fail(error) : ok(undefined);
  });
}

/** "Lien magique" in Expo Go = 6-digit login code: signInWithOtp({ shouldCreateUser: false }).
 *  Unknown e-mail is reported as ok (no enumeration). */
export function requestLoginCode(email: string): Promise<Result<void>> {
  const client = supabase;
  if (!client) return Promise.resolve(notConfigured());
  return guard(async () => {
    const { error } = await client.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: false, emailRedirectTo: redirectTo() },
    });
    if (error) {
      const m = mapAuthError(error);
      return surfacesWithoutEnumeration(m) ? { ok: false, error: m } : ok(undefined);
    }
    return ok(undefined);
  });
}

/** EX_22: ok whatever the account state; only network / rate-limit errors surface. */
export function requestPasswordReset(email: string): Promise<Result<void>> {
  const client = supabase;
  if (!client) return Promise.resolve(notConfigured());
  return guard(async () => {
    const { error } = await client.auth.resetPasswordForEmail(email.trim(), { redirectTo: redirectTo() });
    if (error) {
      const m = mapAuthError(error);
      return surfacesWithoutEnumeration(m) ? { ok: false, error: m } : ok(undefined);
    }
    return ok(undefined);
  });
}

export function updatePassword(newPassword: string): Promise<Result<void>> {
  const client = supabase;
  if (!client) return Promise.resolve(notConfigured());
  return guard(async () => {
    const { error } = await client.auth.updateUser({ password: newPassword });
    return error ? fail(error) : ok(undefined);
  });
}

/** USER_UPDATED then refreshes sessionStore and the kv snapshot (session.ts). */
export function updateProfile(input: { pseudo: string | null }): Promise<Result<void>> {
  const client = supabase;
  if (!client) return Promise.resolve(notConfigured());
  return guard(async () => {
    const pseudo = input.pseudo?.trim() ? input.pseudo.trim() : null;
    const { error } = await client.auth.updateUser({ data: { pseudo } });
    return error ? fail(error) : ok(undefined);
  });
}

/** Bonus deep link (works in builds; best effort in Expo Go): setSession from the URL tokens. */
export function completeAuthFromUrl(url: string): Promise<Result<{ type: string | null }>> {
  const client = supabase;
  if (!client) return Promise.resolve(notConfigured());
  const parsed = parseAuthUrl(url);
  if (parsed.errorDescription || !parsed.accessToken || !parsed.refreshToken) {
    return Promise.resolve(err('invalid', auth.errors.linkInvalid));
  }
  const tokens = { access_token: parsed.accessToken, refresh_token: parsed.refreshToken };
  return guard(async () => {
    const { error } = await client.auth.setSession(tokens);
    if (error) {
      const m = mapAuthError(error);
      return m.code === 'offline' || m.code === 'timeout' ? { ok: false, error: m } : err('invalid', auth.errors.linkInvalid);
    }
    return ok({ type: parsed.type });
  });
}

const FINAL_SYNC_TIMEOUT_MS = 8000;

/** Tries a final sync and returns the number of local changes still unsynced. */
export async function prepareSignOut(): Promise<{ pending: number }> {
  if (!supabase || !sessionStore.get().user) return { pending: 0 };
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      syncNow('manual'),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FINAL_SYNC_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
  } catch {
    // syncNow never rejects; the pending count below is what matters.
  }
  return { pending: syncStore.get().pending };
}

/** Order matters: sync.wipeLocalUserData() FIRST (aborts and awaits any in-flight sync, clears owner_uid) →
 *  supabase.auth.signOut({ scope: 'local' }) (its SIGNED_OUT then finds owner_uid null → sync 'disabled', not
 *  'needs_login') → leaveApp(). Never rejects. */
export async function signOut(): Promise<void> {
  signupCredentials = null;
  try {
    await wipeLocalUserData();
  } catch {
    // Keep going: the user asked to sign out.
  }
  try {
    await supabase?.auth.signOut({ scope: 'local' });
  } catch {
    // Local sign-out only clears storage; nothing else to do.
  }
  leaveApp();
}

/** EX_23: functions.invoke('delete-account') → on success signOut() (local data wiped too). */
export function deleteAccount(): Promise<Result<void>> {
  const client = supabase;
  if (!client) return Promise.resolve(notConfigured());
  if (!sessionStore.get().user) return Promise.resolve(err('unauthorized', auth.errors.notSignedIn));
  return (async (): Promise<Result<void>> => {
    try {
      const { error } = await client.functions.invoke('delete-account', { method: 'POST' });
      if (error) {
        const e = error as { name?: string; context?: { status?: unknown } };
        if (e.name === 'FunctionsFetchError') return { ok: false, error: toAppError(new TypeError('Network request failed')) };
        const status = typeof e.context?.status === 'number' ? e.context.status : undefined;
        if (status === 401 || status === 403) return { ok: false, error: toAppError(error, status) };
        if (status === 429) return { ok: false, error: toAppError(error, status) };
        return err('server', auth.errors.deleteFailed, error);
      }
    } catch (e) {
      const m = toAppError(e);
      return m.code === 'offline' || m.code === 'timeout' ? { ok: false, error: m } : err('server', auth.errors.deleteFailed, e);
    }
    await signOut();
    return ok(undefined);
  })();
}
