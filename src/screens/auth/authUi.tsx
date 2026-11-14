// Small helpers shared by the WP7 screens (auth, account, settings). Not a route.
import { useEffect, useState, type ReactElement } from 'react';
import { StyleSheet, View } from 'react-native';
import { router, type Href } from 'expo-router';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { auth } from '@/i18n/fr/auth';
import { routes } from '@/navigation/routes';
import { enterAsGuest } from '@/state/session';
import { spacing } from '@/theme';

export const GITHUB_URL = 'https://github.com/ycocatrix/BrickHeap';

/** After a successful sign-in (or « Continuer sans compte »): `entered` = true (idempotent; SIGNED_IN already set it),
 *  then back to the root of the app (§3: dismissAll + replace('/')). */
export function goHome(): void {
  enterAsGuest();
  // Next tick: let the root layout re-render with the new Stack.Protected guards before navigating into them.
  setTimeout(() => {
    try {
      if (router.canDismiss()) router.dismissAll();
      router.replace(routes.scanner);
    } catch {
      // The guard flip may already have redirected to the tabs.
    }
  }, 0);
}

/** After sign-out / account deletion (leaveApp() already ran): back to the welcome screen, next tick. */
export function goWelcome(): void {
  setTimeout(() => {
    try {
      if (router.canDismiss()) router.dismissAll();
      router.replace(routes.welcome);
    } catch {
      // The guard flip may already have redirected to welcome.
    }
  }, 0);
}

/** Back when there is somewhere to go back to, else `fallback`. */
export function goBack(fallback: Href): void {
  if (router.canGoBack()) router.back();
  else router.replace(fallback);
}

/** Seconds left before the action can be repeated; `start()` restarts the countdown. */
export function useCooldown(seconds: number, startNow: boolean): { left: number; start: () => void } {
  const [until, setUntil] = useState<number>(() => (startNow ? Date.now() + seconds * 1000 : 0));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until <= now) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until, now]);
  return {
    left: Math.max(0, Math.ceil((until - now) / 1000)),
    start: () => {
      const t = Date.now();
      setNow(t);
      setUntil(t + seconds * 1000);
    },
  };
}

/** Shown on every auth screen when Supabase is not configured (§7.3). The « Continuer sans compte » exit is the
 *  screen's GuestExit. */
export function NotConfiguredNotice(): ReactElement {
  return (
    <View style={s.block}>
      <Banner tone="info" text={auth.notConfiguredHelp} />
    </View>
  );
}

/** « Continuer sans compte » exit, only before the user entered the app (RG_13 exits). */
export function GuestExit(p: { entered: boolean }): ReactElement | null {
  if (p.entered) return null;
  return <Button label={auth.continueAsGuest} variant="ghost" onPress={goHome} />;
}

export const formStyles = StyleSheet.create({
  form: { gap: spacing.lg, paddingVertical: spacing.lg },
  links: { gap: spacing.xs },
});

const s = StyleSheet.create({
  block: { gap: spacing.md },
});
