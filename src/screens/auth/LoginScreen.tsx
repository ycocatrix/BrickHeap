// A2 — Login (EX_20, RG_13). E-mail + password, or a 6-digit login code. No Apple / Google button (D12).
import { useState, type ReactElement } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@/components/Screen';
import { Button } from '@/components/Button';
import { TextField } from '@/components/TextField';
import { Banner } from '@/components/Banner';
import type { AppError } from '@/domain/types';
import { validateEmail, validatePassword } from '@/domain/auth/validation';
import { auth } from '@/i18n/fr/auth';
import { routes } from '@/navigation/routes';
import { requestLoginCode, resendCode, signInWithPassword } from '@/services/auth';
import { useSession } from '@/state/session';
import { colors, font } from '@/theme';
import { formStyles, goBack, goHome, GuestExit, NotConfiguredNotice } from './authUi';

export default function LoginScreen(): ReactElement {
  const { configured, entered } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState<'password' | 'code' | null>(null);

  const submit = async (): Promise<void> => {
    const eErr = validateEmail(email);
    const pErr = password === '' ? validatePassword(password) : null;
    setEmailError(eErr);
    setPasswordError(pErr);
    setError(null);
    if (eErr || pErr) return;
    setBusy('password');
    const r = await signInWithPassword(email.trim(), password);
    setBusy(null);
    if (r.ok) {
      goHome();
      return;
    }
    if (r.error.cause === 'email_not_confirmed') {
      void resendCode(email.trim(), 'signup');
      router.push(routes.verify(email.trim(), 'signup'));
      return;
    }
    setError(r.error);
  };

  const requestCode = async (): Promise<void> => {
    const eErr = validateEmail(email);
    setEmailError(eErr);
    setPasswordError(null);
    setError(null);
    if (eErr) return;
    setBusy('code');
    const r = await requestLoginCode(email.trim());
    setBusy(null);
    if (r.ok) router.push(routes.verify(email.trim(), 'login'));
    else setError(r.error);
  };

  return (
    <Screen title={auth.login.title} onBack={() => goBack(routes.welcome)} scroll>
      <View style={formStyles.form}>
        {configured ? null : <NotConfiguredNotice />}
        <TextField
          label={auth.fields.email}
          value={email}
          onChangeText={setEmail}
          error={emailError}
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          textContentType="emailAddress"
          autoCorrect={false}
          returnKeyType="next"
        />
        <TextField
          label={auth.fields.password}
          value={password}
          onChangeText={setPassword}
          error={passwordError}
          secure
          autoCapitalize="none"
          autoComplete="current-password"
          textContentType="password"
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
        />
        <Button label={auth.login.forgot} variant="ghost" onPress={() => router.push(routes.forgot)} />
        {error ? <Banner tone="error" text={error.message} /> : null}
        <Button
          label={auth.login.submit}
          onPress={() => void submit()}
          loading={busy === 'password'}
          disabled={!configured || busy !== null}
        />
        <Text style={s.or}>{auth.login.or}</Text>
        <Button
          label={auth.login.requestCode}
          icon="mail-outline"
          variant="secondary"
          onPress={() => void requestCode()}
          loading={busy === 'code'}
          disabled={!configured || busy !== null}
          accessibilityHint={auth.login.requestCodeHint}
        />
        <View style={formStyles.links}>
          <Button label={auth.login.noAccount} variant="ghost" onPress={() => router.replace(routes.signup)} />
          <GuestExit entered={entered} />
        </View>
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  or: { color: colors.muted, fontSize: font.small, textAlign: 'center' },
});
