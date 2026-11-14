// Haptic feedback (WP1, §4.3). Respects settingsStore.haptics; never throws.
// iOS does not fire haptics while the camera is active: callers must also show a visual cue (§7.2-9).
import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import { settingsStore } from '@/state/settings';

type Kind = 'success' | 'warning' | 'error' | 'tap';

const ANDROID: Record<Kind, Haptics.AndroidHaptics> = {
  success: Haptics.AndroidHaptics.Confirm,
  warning: Haptics.AndroidHaptics.Long_Press,
  error: Haptics.AndroidHaptics.Reject,
  tap: Haptics.AndroidHaptics.Virtual_Key,
};

function run(kind: Kind): void {
  try {
    if (!settingsStore.get().haptics) return;
    let p: Promise<void>;
    if (Platform.OS === 'android') {
      p = Haptics.performAndroidHapticsAsync(ANDROID[kind]);
    } else if (Platform.OS === 'ios') {
      p =
        kind === 'tap'
          ? Haptics.selectionAsync()
          : Haptics.notificationAsync(
              kind === 'success'
                ? Haptics.NotificationFeedbackType.Success
                : kind === 'warning'
                  ? Haptics.NotificationFeedbackType.Warning
                  : Haptics.NotificationFeedbackType.Error,
            );
    } else {
      return;
    }
    p.catch(() => undefined);
  } catch {
    // Haptics unavailable: silently ignored.
  }
}

export const feedback: { success(): void; warning(): void; error(): void; tap(): void } = {
  success: () => run('success'),
  warning: () => run('warning'),
  error: () => run('error'),
  tap: () => run('tap'),
};
