// A5 — Compte tab (EX_23, RG_12). Signed in: identity, sync status, account rows, sign-out.
// Guest: warn card + create account / sign in. Session expired (needs_login): re-login banner + keep-as-guest exit.
import { useState, type ReactElement } from 'react';
import { Alert, Linking, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@/components/Screen';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { ListRow } from '@/components/ListRow';
import { Icon, type IconName } from '@/components/Icon';
import { tpl, plural } from '@/i18n/format';
import { account } from '@/i18n/fr/account';
import { common } from '@/i18n/fr/common';
import { routes } from '@/navigation/routes';
import { prepareSignOut, signOut } from '@/services/auth';
import { keepLocalAsGuest, useSyncStatus } from '@/services/sync';
import { SyncStatusLine } from '@/screens/sync/SyncStatusLine';
import { useSession } from '@/state/session';
import { colors, font, radius, spacing } from '@/theme';
import { GITHUB_URL, goWelcome } from '@/screens/auth/authUi';

function RowIcon(p: { name: IconName }): ReactElement {
  return <Icon name={p.name} size={22} color={colors.muted} />;
}

function Chevron(): ReactElement {
  return <Icon name="chevron-forward" size={20} color={colors.muted} />;
}

export default function AccountScreen(): ReactElement {
  const { user, configured } = useSession();
  const sync = useSyncStatus();
  const [signingOut, setSigningOut] = useState(false);
  const expired = sync.state === 'needs_login';

  const doSignOut = async (): Promise<void> => {
    await signOut();
    setSigningOut(false);
    goWelcome();
  };

  const onSignOut = async (): Promise<void> => {
    setSigningOut(true);
    const { pending } = await prepareSignOut();
    if (pending > 0) {
      Alert.alert(
        account.signOut.pendingTitle,
        tpl(plural(pending, account.signOut.pendingOne, account.signOut.pendingOther), { n: pending }),
        [
          { text: common.actions.cancel, style: 'cancel', onPress: () => setSigningOut(false) },
          { text: account.signOut.confirm, style: 'destructive', onPress: () => void doSignOut() },
        ],
        { cancelable: true, onDismiss: () => setSigningOut(false) },
      );
      return;
    }
    await doSignOut();
  };

  const onKeepLocal = (): void => {
    Alert.alert(account.expired.confirmTitle, account.expired.confirmText, [
      { text: common.actions.cancel, style: 'cancel' },
      { text: account.expired.confirm, onPress: () => void keepLocalAsGuest().catch(() => undefined) },
    ]);
  };

  const commonRows = (
    <>
      <ListRow
        title={account.rows.settings}
        left={<RowIcon name="settings-outline" />}
        right={<Chevron />}
        onPress={() => router.push(routes.settings)}
      />
      <ListRow
        title={account.rows.export}
        left={<RowIcon name="download-outline" />}
        right={<Chevron />}
        onPress={() => router.push(routes.exportSheet(null))}
      />
      <ListRow
        title={account.rows.about}
        left={<RowIcon name="information-circle-outline" />}
        right={<Chevron />}
        onPress={() => router.push(routes.about)}
      />
      <ListRow
        title={account.rows.legal}
        left={<RowIcon name="document-text-outline" />}
        right={<Chevron />}
        onPress={() => router.push(routes.about)}
      />
      <ListRow
        title={account.rows.github}
        subtitle={account.rows.githubHint}
        left={<RowIcon name="logo-github" />}
        right={<Icon name="open-outline" size={20} color={colors.muted} />}
        onPress={() => void Linking.openURL(GITHUB_URL).catch(() => undefined)}
      />
    </>
  );

  const displayName = user ? (user.pseudo ?? user.email) : '';
  const initial = displayName.trim().charAt(0).toUpperCase() || '?';

  return (
    <Screen title={account.title} scroll>
      <View style={s.content}>
        {!configured ? <Banner tone="info" text={account.notConfigured} /> : null}

        {expired ? (
          <View style={s.block}>
            <Banner
              tone="warn"
              text={account.expired.text}
              actionLabel={account.expired.signIn}
              onAction={() => router.push(routes.login)}
            />
            <Button label={account.expired.keepLocal} variant="secondary" onPress={onKeepLocal} />
          </View>
        ) : null}

        {user ? (
          <>
            <View style={s.identity}>
              <View style={s.avatar} accessible accessibilityRole="image" accessibilityLabel={tpl(account.avatarLabel, { name: displayName })}>
                <Text style={s.avatarText}>{initial}</Text>
              </View>
              <View style={s.identityText}>
                <Text style={s.name} accessibilityRole="header">
                  {user.pseudo ?? account.noPseudo}
                </Text>
                <Text style={s.email}>{user.email}</Text>
                <SyncStatusLine />
              </View>
            </View>
            <View>
              <ListRow
                title={account.rows.profile}
                left={<RowIcon name="person-outline" />}
                right={<Chevron />}
                onPress={() => router.push(routes.profile)}
              />
              <ListRow
                title={account.rows.password}
                left={<RowIcon name="key-outline" />}
                right={<Chevron />}
                onPress={() => router.push(routes.changePassword)}
              />
              {commonRows}
            </View>
            <Button
              label={account.signOut.action}
              variant="secondary"
              icon="log-out-outline"
              onPress={() => void onSignOut()}
              loading={signingOut}
              disabled={signingOut}
            />
          </>
        ) : (
          <>
            {expired ? null : (
              <View style={s.guestCard}>
                <View style={s.guestTitleRow}>
                  <Icon name="warning-outline" size={22} color={colors.warn} />
                  <Text style={s.guestTitle} accessibilityRole="header">
                    {account.guest.title}
                  </Text>
                </View>
                <Text style={s.guestText}>{account.guest.text}</Text>
                <Button
                  label={account.guest.createAccount}
                  onPress={() => router.push(routes.signup)}
                  disabled={!configured}
                />
                <Button
                  label={account.guest.signIn}
                  variant="secondary"
                  onPress={() => router.push(routes.login)}
                  disabled={!configured}
                />
              </View>
            )}
            <View>{commonRows}</View>
          </>
        )}
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  content: { gap: spacing.lg, paddingBottom: spacing.xl },
  block: { gap: spacing.sm },
  identity: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.onPrimary, fontSize: font.title, fontWeight: '700' },
  identityText: { flex: 1, gap: spacing.xs },
  name: { color: colors.text, fontSize: font.h2, fontWeight: '700' },
  email: { color: colors.muted, fontSize: font.small },
  guestCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.warn,
    padding: spacing.lg,
    gap: spacing.md,
  },
  guestTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  guestTitle: { color: colors.text, fontSize: font.h2, fontWeight: '700' },
  guestText: { color: colors.text, fontSize: font.body },
});
