// A1 — Welcome (EX_19, D13). First launch: create an account, sign in, or continue as a guest.
import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@/components/Screen';
import { Button } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { auth } from '@/i18n/fr/auth';
import { common } from '@/i18n/fr/common';
import { routes } from '@/navigation/routes';
import { useSession } from '@/state/session';
import { colors, font, spacing } from '@/theme';
import { goHome } from './authUi';

export default function WelcomeScreen(): ReactElement {
  const { configured } = useSession();
  return (
    <Screen
      scroll
      footer={
        <View style={s.footer}>
          <Button
            label={auth.welcome.createAccount}
            onPress={() => router.push(routes.signup)}
            disabled={!configured}
            accessibilityHint={configured ? undefined : auth.notConfigured}
          />
          <Button
            label={auth.welcome.signIn}
            variant="secondary"
            onPress={() => router.push(routes.login)}
            disabled={!configured}
            accessibilityHint={configured ? undefined : auth.notConfigured}
          />
          {configured ? null : (
            <View style={s.note} accessibilityRole="text">
              <Icon name="information-circle-outline" size={18} color={colors.muted} />
              <Text style={s.noteText}>{auth.notConfigured}</Text>
            </View>
          )}
          <Button label={auth.continueAsGuest} variant="ghost" onPress={goHome} />
          <Text style={s.legal}>{common.legal.notAffiliated}</Text>
        </View>
      }
    >
      <View style={s.hero}>
        <View style={s.logo} accessible accessibilityRole="image" accessibilityLabel={auth.welcome.logoLabel}>
          <Icon name="cube" size={72} color={colors.primary} />
        </View>
        <Text style={s.wordmark} accessibilityRole="header">
          {common.appName.toLowerCase()}
        </Text>
        <Text style={s.tagline}>{auth.welcome.tagline}</Text>
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  hero: { alignItems: 'center', paddingTop: spacing.xl * 2, gap: spacing.md },
  logo: { padding: spacing.lg },
  wordmark: { color: colors.text, fontSize: font.title + 10, fontWeight: '800' },
  tagline: { color: colors.muted, fontSize: font.body, textAlign: 'center', paddingHorizontal: spacing.lg },
  footer: { gap: spacing.sm, padding: spacing.lg },
  note: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center', justifyContent: 'center' },
  noteText: { color: colors.muted, fontSize: font.small, flexShrink: 1 },
  legal: { color: colors.muted, fontSize: font.tiny, textAlign: 'center', marginTop: spacing.sm },
});
