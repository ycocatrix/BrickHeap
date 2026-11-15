import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { AppError } from '@/domain/types';
import { Screen } from '@/components/Screen';
import { Button } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { common } from '@/i18n/fr/common';
import { colors, font, spacing } from '@/theme';

/** The local database could not be opened (§7.3). Shown by the root layout instead of the navigator. */
export default function BootErrorScreen(p: { error: AppError; onRetry: () => void }): ReactElement {
  return (
    <Screen>
      <View style={s.body} accessible accessibilityRole="alert">
        <Icon name="alert-circle-outline" size={48} color={colors.error} />
        <Text style={s.title}>{common.boot.failedTitle}</Text>
        <Text style={s.text}>{common.boot.failedMessage}</Text>
        <Text style={s.detail}>{p.error.message}</Text>
      </View>
      <Button label={common.actions.retry} icon="refresh" onPress={p.onRetry} style={s.button} />
    </Screen>
  );
}

const s = StyleSheet.create({
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  title: { color: colors.text, fontSize: font.title, fontWeight: '700', textAlign: 'center' },
  text: { color: colors.text, fontSize: font.body, textAlign: 'center' },
  detail: { color: colors.muted, fontSize: font.small, textAlign: 'center' },
  button: { marginBottom: spacing.xl },
});
