import { useCallback, useEffect, useState } from 'react';
import { SplashScreen } from 'expo-router';
import type { AppError } from '@/domain/types';
import { toAppError } from '@/domain/result';
import { openDb } from '@/data/db';
import { loadSettings } from '@/state/settings';
import { initSession } from '@/state/session';

type BootState = { status: 'loading' | 'ready' } | { status: 'error'; error: AppError; retry: () => void };

/** openDb() → loadSettings() → initSession() (synchronous, kv only). Nothing on this path waits for the network.
 *  Hides the splash screen when it settles. */
export function useBoot(): BootState {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<BootState>({ status: 'loading' });
  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((a) => a + 1);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await openDb();
        loadSettings();
        initSession();
        if (alive) setState({ status: 'ready' });
      } catch (e) {
        if (alive) setState({ status: 'error', error: toAppError(e), retry });
      } finally {
        if (alive) SplashScreen.hide();
      }
    })();
    return () => {
      alive = false;
    };
  }, [attempt, retry]);

  return state;
}
