import { useEffect, type ReactElement } from 'react';
import { SplashScreen, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useBoot } from '@/hooks/useBoot';
import { useStore } from '@/state/createStore';
import { sessionStore } from '@/state/session';
import { startSync } from '@/services/sync';
import { GuestMergeHost } from '@/screens/sync/GuestMergeHost';
import { SnackbarHost } from '@/components/Snackbar';
import BootErrorScreen from '@/screens/BootErrorScreen';
import { colors } from '@/theme';

void SplashScreen.preventAutoHideAsync(); // hidden by useBoot when it settles

export default function RootLayout(): ReactElement | null {
  const boot = useBoot(); // openDb() → loadSettings() → initSession(); no network
  const entered = useStore(sessionStore, (s) => s.entered);
  useEffect(() => (boot.status === 'ready' ? startSync() : undefined), [boot.status]);

  if (boot.status === 'loading') return null; // splash still visible
  if (boot.status === 'error') return <BootErrorScreen error={boot.error} onRetry={boot.retry} />;
  return (
    <>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Protected guard={!entered}>
          <Stack.Screen name="welcome" />
        </Stack.Protected>
        <Stack.Protected guard={entered}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="scan/review" />
          <Stack.Screen name="part/[partId]" />
          <Stack.Screen
            name="export"
            options={{ presentation: 'formSheet', sheetAllowedDetents: [0.6], sheetGrabberVisible: true }}
          />
          <Stack.Screen name="settings/index" />
          <Stack.Screen name="settings/calibration" />
          <Stack.Screen name="profile" />
          <Stack.Screen name="change-password" />
        </Stack.Protected>
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="auth/callback" />
        <Stack.Screen name="about" />
      </Stack>
      <GuestMergeHost />
      <SnackbarHost />
    </>
  );
}
