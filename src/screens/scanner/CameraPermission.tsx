// EX_08 / B4: explanation before the system prompt, explanatory empty state after « Plus tard » or a refusal.
import { useState, type ReactElement } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import type { PermissionResponse } from 'expo-camera';
import { Button } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { LoadingState } from '@/components/StateViews';
import { scanner } from '@/i18n/fr/scanner';
import { colors, font, radius, spacing } from '@/theme';

const t = scanner.permission;

export function CameraPermission(p: {
  permission: PermissionResponse | null;
  requestPermission: () => Promise<PermissionResponse>;
}): ReactElement {
  const [later, setLater] = useState(false);
  const [asking, setAsking] = useState(false);

  if (!p.permission) {
    return (
      <View style={s.center}>
        <LoadingState label={t.loading} />
      </View>
    );
  }

  const blocked = !p.permission.canAskAgain && !p.permission.granted;
  const denied = p.permission.status === 'denied';

  const ask = async () => {
    if (blocked) {
      Linking.openSettings().catch(() => undefined);
      return;
    }
    setAsking(true);
    try {
      await p.requestPermission();
    } catch {
      // The hook keeps the previous status; the user can try again.
    } finally {
      setAsking(false);
    }
  };

  const action = (
    <Button
      label={blocked ? t.openSettings : t.allow}
      icon={blocked ? 'settings-outline' : 'camera-outline'}
      onPress={() => void ask()}
      loading={asking}
    />
  );

  // First visit: the explanation sheet, before the system prompt.
  if (!later && !denied && !blocked) {
    return (
      <View style={s.sheetWrap}>
        <View style={s.sheet} accessibilityRole="summary">
          <View style={s.iconRow}>
            <Icon name="camera-outline" size={32} color={colors.primary} />
          </View>
          <Text style={s.title} accessibilityRole="header">
            {t.title}
          </Text>
          <Text style={s.body}>{t.body}</Text>
          {action}
          <Button label={t.later} variant="ghost" onPress={() => setLater(true)} style={s.gap} />
        </View>
      </View>
    );
  }

  return (
    <View style={s.center}>
      <Icon name="camera-outline" size={48} color={colors.muted} />
      <Text style={s.title} accessibilityRole="header">
        {t.deniedTitle}
      </Text>
      <Text style={s.body}>{blocked ? t.blockedBody : t.deniedBody}</Text>
      <Text style={s.small}>{t.body}</Text>
      {action}
    </View>
  );
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.md, backgroundColor: colors.bg },
  sheetWrap: { flex: 1, justifyContent: 'flex-end', backgroundColor: colors.bg },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.xl,
    gap: spacing.md,
  },
  iconRow: { alignItems: 'center' },
  title: { color: colors.text, fontSize: font.h2, fontWeight: '700', textAlign: 'center' },
  body: { color: colors.text, fontSize: font.body, textAlign: 'center' },
  small: { color: colors.muted, fontSize: font.small, textAlign: 'center' },
  gap: { marginTop: spacing.xs },
});
