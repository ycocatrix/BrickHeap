import type { ReactElement } from 'react';
import { Stack } from 'expo-router';
import { colors } from '@/theme';

// Auth screens carry their own title / back button (Screen, WP1): no navigator header.
export default function AuthLayout(): ReactElement {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />;
}
