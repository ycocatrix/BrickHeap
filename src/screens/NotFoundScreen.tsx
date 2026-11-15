import type { ReactElement } from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@/components/Screen';
import { Button } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { common } from '@/i18n/fr/common';
import { routes } from '@/navigation/routes';
import { colors, spacing } from '@/theme';

/** Unknown route (§7.3): one way out, back to the scanner. */
export default function NotFoundScreen(): ReactElement {
  return (
    <Screen title={common.notFound.title}>
      <View style={s.body}>
        <Icon name="help-circle-outline" size={48} color={colors.muted} />
        <Button label={common.notFound.action} icon="scan-outline" onPress={() => router.replace(routes.scanner)} />
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.xl },
});
