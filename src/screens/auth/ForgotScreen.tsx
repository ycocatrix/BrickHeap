// A4 — Forgot password (EX_22). Always the same confirmation, whether the account exists or not.
import { useState, type ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@/components/Screen';
import { Button } from '@/components/Button';
import { TextField } from '@/components/TextField';
import { Banner } from '@/components/Banner';
import type { AppError } from '@/domain/types';
import { validateEmail } from '@/domain/auth/validation';
import { auth } from '@/i18n/fr/auth';
import { routes } from '@/navigation/routes';
import { requestPasswordReset } from '@/services/auth';
import { useSession } from '@/state/session';
import { colors, font } from '@/theme';
import { formStyles, goBack, GuestExit, NotConfiguredNotice } from './authUi';

export default function ForgotScreen(): ReactElement {
  const { configured, entered } = useSession();
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const eErr = validateEmail(email);
    setEmailError(eErr);
    setError(null);
    if (eErr) return;
    setBusy(true);
    const r = await requestPasswordReset(email.trim());
    setBusy(false);
    if (r.ok) setSentTo(email.trim());
    else setError(r.error);
  };

  return (
    <Screen title={auth.forgot.title} onBack={() => goBack(routes.login)} scroll>
      <View style={formStyles.form}>
        {configured ? null : <NotConfiguredNotice />}
        <Text style={s.intro}>{auth.forgot.intro}</Text>
        <TextField
          label={auth.fields.email}
          value={email}
          onChangeText={(v) => {
            setEmail(v);
            if (sentTo) setSentTo(null);
          }}
          error={emailError}
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          textContentType="emailAddress"
          autoCorrect={false}
          returnKeyType="send"
          onSubmitEditing={() => void submit()}
        />
        {error ? <Banner tone="error" text={error.message} /> : null}
        {sentTo ? (
          <>
            <Banner tone="ok" text={auth.forgot.sent} />
            <Button label={auth.forgot.enterCode} onPress={() => router.push(routes.verify(sentTo, 'recovery'))} />
          </>
        ) : (
          <Button label={auth.forgot.submit} onPress={() => void submit()} loading={busy} disabled={!configured || busy} />
        )}
        <View style={formStyles.links}>
          <GuestExit entered={entered} />
        </View>
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  intro: { color: colors.muted, fontSize: font.body },
});
