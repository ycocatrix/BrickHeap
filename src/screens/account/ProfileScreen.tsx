// Edit profile (EX_23): pseudo only; the e-mail is shown read-only.
import { useState, type ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@/components/Screen';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { TextField } from '@/components/TextField';
import type { AppError } from '@/domain/types';
import { tpl } from '@/i18n/format';
import { account } from '@/i18n/fr/account';
import { auth } from '@/i18n/fr/auth';
import { common } from '@/i18n/fr/common';
import { routes } from '@/navigation/routes';
import { updateProfile } from '@/services/auth';
import { useSession } from '@/state/session';
import { formStyles, goBack } from '@/screens/auth/authUi';
import { colors, font, spacing } from '@/theme';

const PSEUDO_MAX = 40;

export default function ProfileScreen(): ReactElement {
  const { user, configured } = useSession();
  const [pseudo, setPseudo] = useState(user?.pseudo ?? '');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    const v = pseudo.trim();
    const fErr = v.length > PSEUDO_MAX ? tpl(account.profile.pseudoTooLong, { n: PSEUDO_MAX }) : null;
    setFieldError(fErr);
    setError(null);
    setSaved(false);
    if (fErr) return;
    setBusy(true);
    const r = await updateProfile({ pseudo: v === '' ? null : v });
    setBusy(false);
    if (r.ok) setSaved(true);
    else setError(r.error);
  };

  return (
    <Screen title={account.profile.title} onBack={() => goBack(routes.account)} scroll>
      {!configured ? (
        <Banner tone="info" text={auth.notConfiguredHelp} />
      ) : !user ? (
        <View style={formStyles.form}>
          <Banner tone="info" text={account.profile.signedOut} />
          <Button label={auth.welcome.signIn} onPress={() => router.push(routes.login)} />
        </View>
      ) : (
        <View style={formStyles.form}>
          <View accessible accessibilityLabel={`${account.profile.email}, ${user.email}`}>
            <Text style={s.label}>{account.profile.email}</Text>
            <Text style={s.value}>{user.email}</Text>
          </View>
          <TextField
            label={account.profile.pseudo}
            value={pseudo}
            onChangeText={(v) => {
              setPseudo(v);
              setSaved(false);
            }}
            error={fieldError}
            autoComplete="username"
            textContentType="nickname"
            accessibilityHint={account.profile.pseudoHint}
            returnKeyType="done"
            onSubmitEditing={() => void save()}
          />
          <Text style={s.hint}>{account.profile.pseudoHint}</Text>
          {error ? <Banner tone="error" text={error.message} /> : null}
          {saved ? <Banner tone="ok" text={account.profile.saved} /> : null}
          <Button label={common.actions.save} onPress={() => void save()} loading={busy} disabled={busy} />
        </View>
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  label: { color: colors.muted, fontSize: font.small, marginBottom: spacing.xs },
  value: { color: colors.text, fontSize: font.body },
  hint: { color: colors.muted, fontSize: font.small },
});
