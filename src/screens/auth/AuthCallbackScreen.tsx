// Deep-link callback (bonus, D12): works in builds, best effort in Expo Go.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import * as Linking from 'expo-linking';
import { router } from 'expo-router';
import { Screen } from '@/components/Screen';
import { ErrorState, LoadingState } from '@/components/StateViews';
import type { AppError } from '@/domain/types';
import { auth } from '@/i18n/fr/auth';
import { routes } from '@/navigation/routes';
import { completeAuthFromUrl } from '@/services/auth';
import { goHome } from './authUi';

const NO_URL_TIMEOUT_MS = 3000;

export default function AuthCallbackScreen(): ReactElement {
  const url = Linking.useLinkingURL();
  const [error, setError] = useState<AppError | null>(null);
  const handled = useRef<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    if (!url) {
      const t = setTimeout(() => setError({ code: 'invalid', message: auth.errors.linkInvalid }), NO_URL_TIMEOUT_MS);
      return () => clearTimeout(t);
    }
    if (handled.current === url) return undefined;
    handled.current = url;
    setError(null);
    void completeAuthFromUrl(url).then((r) => {
      if (!mounted.current || handled.current !== url) return;
      if (!r.ok) setError(r.error);
      else if (r.value.type === 'recovery') router.replace(routes.newPassword);
      else goHome();
    });
    return undefined;
  }, [url]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  return (
    <Screen title={auth.callback.title}>
      {error ? (
        <ErrorState
          error={error}
          secondaryLabel={auth.callback.signIn}
          onSecondary={() => router.replace(routes.login)}
        />
      ) : (
        <LoadingState label={auth.callback.loading} />
      )}
    </Screen>
  );
}
