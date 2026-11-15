// Code entry (EX_20 / EX_21 / EX_22, D12): sign-up confirmation, login code, password reset.
import { useState, type ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Screen } from '@/components/Screen';
import { Button } from '@/components/Button';
import { TextField } from '@/components/TextField';
import { Banner } from '@/components/Banner';
import type { AppError } from '@/domain/types';
import { validateCode } from '@/domain/auth/validation';
import { tpl } from '@/i18n/format';
import { auth } from '@/i18n/fr/auth';
import { routes, type CodePurpose } from '@/navigation/routes';
import { confirmedViaLink, resendCode, verifyCode } from '@/services/auth';
import { useSession } from '@/state/session';
import { colors, font } from '@/theme';
import { formStyles, goBack, goHome, GuestExit, NotConfiguredNotice, useCooldown } from './authUi';

const RESEND_COOLDOWN_S = 60;

function asPurpose(v: unknown): CodePurpose {
  return v === 'login' || v === 'recovery' ? v : 'signup';
}

export default function VerifyCodeScreen(): ReactElement {
  const params = useLocalSearchParams<{ email?: string; purpose?: string }>();
  const email = typeof params.email === 'string' ? params.email : '';
  const purpose = asPurpose(params.purpose);
  const { configured, entered } = useSession();
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState<'verify' | 'resend' | 'link' | null>(null);
  // A code was sent just before this screen opened: the cooldown starts immediately.
  const cooldown = useCooldown(RESEND_COOLDOWN_S, true);

  const afterSuccess = (): void => {
    if (purpose === 'recovery') router.replace(routes.newPassword);
    else goHome();
  };

  const submit = async (): Promise<void> => {
    const cErr = validateCode(code);
    setCodeError(cErr);
    setError(null);
    setInfo(null);
    if (cErr) return;
    setBusy('verify');
    const r = await verifyCode({ email, code: code.trim(), purpose });
    setBusy(null);
    if (r.ok) afterSuccess();
    else if (r.error.cause === 'code_invalid') setCodeError(r.error.message);
    else setError(r.error);
  };

  const resend = async (): Promise<void> => {
    setError(null);
    setInfo(null);
    setBusy('resend');
    const r = await resendCode(email, purpose);
    setBusy(null);
    if (r.ok) {
      cooldown.start();
      setInfo(auth.verify.resent);
    } else {
      setError(r.error);
    }
  };

  const viaLink = async (): Promise<void> => {
    setError(null);
    setInfo(null);
    setBusy('link');
    const r = await confirmedViaLink();
    setBusy(null);
    if (r.ok) goHome();
    else setError(r.error);
  };

  const changeEmail = (): void =>
    goBack(purpose === 'signup' ? routes.signup : purpose === 'recovery' ? routes.forgot : routes.login);

  return (
    <Screen title={auth.verify.title} onBack={changeEmail} scroll>
      <View style={formStyles.form}>
        {configured ? null : <NotConfiguredNotice />}
        {email === '' ? (
          <Banner tone="error" text={auth.verify.missingEmail} />
        ) : (
          <Text style={s.intro}>{tpl(purpose === 'signup' ? auth.verify.introSignup : auth.verify.intro, { email })}</Text>
        )}
        <TextField
          label={auth.fields.code}
          value={code}
          onChangeText={(v) => setCode(v.replace(/[^\d]/g, ''))}
          error={codeError}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          maxLength={8}
          returnKeyType="done"
          onSubmitEditing={() => void submit()}
        />
        {error ? <Banner tone="error" text={error.message} /> : null}
        {info ? <Banner tone="ok" text={info} /> : null}
        <Button
          label={auth.verify.submit}
          onPress={() => void submit()}
          loading={busy === 'verify'}
          disabled={!configured || email === '' || busy !== null}
        />
        <Button
          label={cooldown.left > 0 ? tpl(auth.verify.resendIn, { s: cooldown.left }) : auth.verify.resend}
          variant="secondary"
          onPress={() => void resend()}
          loading={busy === 'resend'}
          disabled={!configured || email === '' || busy !== null || cooldown.left > 0}
        />
        {purpose === 'signup' ? (
          <Button
            label={auth.verify.confirmedViaLink}
            variant="secondary"
            onPress={() => void viaLink()}
            loading={busy === 'link'}
            disabled={!configured || busy !== null}
          />
        ) : null}
        <View style={formStyles.links}>
          <Button label={auth.verify.changeEmail} variant="ghost" onPress={changeEmail} />
          <Button
            label={purpose === 'signup' ? auth.verify.haveAccount : auth.verify.signInWithPassword}
            variant="ghost"
            onPress={() => router.replace(routes.login)}
          />
          <GuestExit entered={entered} />
        </View>
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  intro: { color: colors.muted, fontSize: font.body },
});
