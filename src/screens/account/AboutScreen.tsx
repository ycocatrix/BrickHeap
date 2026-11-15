// About, legal notice, privacy notice and terms (EX_23, R5). Reachable without an account.
import type { ReactElement } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { Screen } from '@/components/Screen';
import { Button } from '@/components/Button';
import { tpl } from '@/i18n/format';
import { account } from '@/i18n/fr/account';
import { common } from '@/i18n/fr/common';
import { routes } from '@/navigation/routes';
import { GITHUB_URL, goBack } from '@/screens/auth/authUi';
import { useSession } from '@/state/session';
import { colors, font, radius, spacing } from '@/theme';

function Section(p: { title: string; paragraphs: readonly string[] }): ReactElement {
  return (
    <View style={s.section}>
      <Text style={s.h2} accessibilityRole="header">
        {p.title}
      </Text>
      {p.paragraphs.map((t) => (
        <Text key={t} style={s.p}>
          {t}
        </Text>
      ))}
    </View>
  );
}

export default function AboutScreen(): ReactElement {
  const version = Constants.expoConfig?.version ?? '—';
  const { entered } = useSession();
  return (
    <Screen title={account.about.title} onBack={() => goBack(entered ? routes.account : routes.welcome)} scroll>
      <View style={s.content}>
        <View style={s.card}>
          <Text style={s.app}>{common.appName}</Text>
          <Text style={s.p}>{tpl(account.about.version, { v: version })}</Text>
          <Text style={s.p}>{common.legal.notAffiliated}</Text>
          <Button
            label={account.about.github}
            icon="logo-github"
            variant="secondary"
            onPress={() => void Linking.openURL(GITHUB_URL).catch(() => undefined)}
            accessibilityHint={account.rows.githubHint}
          />
        </View>
        <Section title={account.about.sourcesTitle} paragraphs={[account.about.sources]} />
        <Section title={account.about.privacyTitle} paragraphs={account.about.privacy} />
        <Section title={account.about.cguTitle} paragraphs={account.about.cgu} />
        <Section title={account.about.legalTitle} paragraphs={[common.legal.notAffiliated, account.about.legal]} />
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  content: { gap: spacing.xl, paddingVertical: spacing.lg },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm },
  app: { color: colors.text, fontSize: font.title, fontWeight: '700' },
  section: { gap: spacing.sm },
  h2: { color: colors.text, fontSize: font.h2, fontWeight: '700' },
  p: { color: colors.text, fontSize: font.body, lineHeight: 22 },
});
