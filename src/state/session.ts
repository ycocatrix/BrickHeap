import type { SessionUser } from '@/domain/types';
import { isSupabaseConfigured } from '@/services/env';
import { kv } from '@/services/kv';
import { registerAutoRefresh, supabase } from '@/services/supabase';
import { createStore, useStore, type Store } from './createStore';

export interface SessionState {
  status: 'loading' | 'ready';
  user: SessionUser | null;
  /** The user passed the welcome screen (guest or signed in). Persisted in kv 'entered'. */
  entered: boolean;
  configured: boolean;
}

const ENTERED_KEY = 'entered';
const USER_KEY = 'session.user';

export const sessionStore: Store<SessionState> = createStore<SessionState>({
  status: 'loading',
  user: null,
  entered: false,
  configured: isSupabaseConfigured(),
});

/** id, email, user_metadata.pseudo (string or null). */
export function toSessionUser(session: {
  user: { id: string; email?: string | null; user_metadata?: Record<string, unknown> };
}): SessionUser {
  const pseudo = session.user.user_metadata?.pseudo;
  return {
    id: session.user.id,
    email: session.user.email ?? '',
    pseudo: typeof pseudo === 'string' && pseudo.trim() !== '' ? pseudo : null,
  };
}

function readUserSnapshot(): SessionUser | null {
  const u = kv.getJson<unknown>(USER_KEY, null);
  if (!u || typeof u !== 'object') return null;
  const o = u as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.email !== 'string') return null;
  return { id: o.id, email: o.email, pseudo: typeof o.pseudo === 'string' ? o.pseudo : null };
}

function setUser(user: SessionUser | null): void {
  if (user) kv.setJson(USER_KEY, { id: user.id, email: user.email, pseudo: user.pseudo });
  else kv.remove(USER_KEY);
  sessionStore.set({ user });
}

function setEntered(entered: boolean): void {
  if (entered) kv.setString(ENTERED_KEY, '1');
  else kv.remove(ENTERED_KEY);
  sessionStore.set({ entered });
}

let initialised = false;

/** SYNCHRONOUS, never awaits supabase. Restores `entered` and the kv user snapshot, then subscribes to auth events
 *  in the background (RG_12). INITIAL_SESSION with a null session is ignored (also emitted when an offline refresh
 *  fails while the refresh token is still valid). Idempotent. */
export function initSession(): void {
  if (initialised) return;
  initialised = true;
  sessionStore.set({
    status: 'ready',
    entered: kv.getString(ENTERED_KEY) === '1',
    user: readUserSnapshot(),
    configured: isSupabaseConfigured(),
  });
  const client = supabase;
  if (!client) return;
  registerAutoRefresh();
  // The callback must stay synchronous and never call another supabase.auth method (auth-js holds a lock).
  client.auth.onAuthStateChange((event, session) => {
    switch (event) {
      case 'SIGNED_IN':
      case 'USER_UPDATED':
      case 'TOKEN_REFRESHED':
        if (!session) return;
        setUser(toSessionUser(session));
        if (event === 'SIGNED_IN') setEntered(true);
        return;
      case 'SIGNED_OUT':
        setUser(null);
        return;
      default:
        // INITIAL_SESSION (null ignored; a non-null one refreshes the snapshot), PASSWORD_RECOVERY, MFA…
        if (event === 'INITIAL_SESSION' && session) setUser(toSessionUser(session));
    }
  });
}

/** entered = true ("Continuer sans compte"). */
export function enterAsGuest(): void {
  setEntered(true);
}

/** entered = false, after an explicit sign-out or an account deletion. */
export function leaveApp(): void {
  setEntered(false);
}

const selectAll = (s: SessionState): SessionState => s;
export function useSession(): SessionState {
  return useStore(sessionStore, selectAll);
}
