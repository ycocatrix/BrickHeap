// A3 — Sign-up (EX_21). Pseudo (optional), e-mail, password, required consent; field-level errors.
import { useState, type ReactElement } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@/components/Screen';
import { Button } from '@/components/Button';
import { TextField } from '@/components/TextField';
import { Banner } from '@/components/Banner';
import { Icon } from '@/components/Icon';
import type { AppError } from '@/domain/types';
import { validateEmail, validatePassword } from '@/domain/auth/validation';
import { auth } from '@/i18n/fr/auth';
import { routes } from '@/navigation/routes';
import { signUp } from '@/services/auth';
import { useSession } from '@/state/session';
import { colors, font, spacing, touch } from '@/theme';
import { formStyles, goBack, goHome, GuestExit, NotConfiguredNotice } from './authUi';

export default function SignupScreen(): ReactElement {
  const { configured, entered } = useSession();
  const [pseudo, setPseudo] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [cgu, setCgu] = useState(false);
  const [errors, setErrors] = useState<{ email: string | null; password: string | null; cgu: string | null }>({
    email: null,
    password: null,
    cgu: null,
  });
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const next = {
      email: validateEmail(email),
      password: validatePassword(password),
      cgu: cgu ? null : auth.validation.cguRequired,
    };
    setErrors(next);
    setError(null);
    if (next.email || next.password || next.cgu) return;
    setBusy(true);
    const r = await signUp({ email: email.trim(), password, pseudo: pseudo.trim() || undefined });
    setBusy(false);
    if (!r.ok) {
      if (r.error.cause === 'weak_password') setErrors({ ...next, password: r.error.message });
      else setError(r.error);
      return;
    }
    if (r.value.needsCode) router.push(routes.verify(email.trim(), 'signup'));
    else goHome();
  };

  return (
    <Screen title={auth.signup.title} onBack={() => goBack(routes.welcome)} scroll>
      <View style={formStyles.form}>
        {configured ? null : <NotConfiguredNotice />}
        <TextField
          label={auth.fields.pseudo}
          value={pseudo}
          onChangeText={setPseudo}
          autoComplete="username"
          textContentType="nickname"
          maxLength={40}
          returnKeyType="next"
        />
        <TextField
          label={auth.fields.email}
          value={email}
          onChangeText={setEmail}
          error={errors.email}
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          textContentType="emailAddress"
          autoCorrect={false}
          returnKeyType="next"
        />
        <TextField
          label={auth.fields.passwordNew}
          value={password}
          onChangeText={setPassword}
          error={errors.password}
          secure
          autoCapitalize="none"
          autoComplete="new-password"
          textContentType="newPassword"
        />
        <View>
          <Pressable
            onPress={() => setCgu((v) => !v)}
            accessibilityRole="checkbox"
            accessibilityLabel={auth.signup.cgu}
            accessibilityState={{ checked: cgu }}
            style={s.check}
          >
            <Icon name={cgu ? 'checkbox' : 'square-outline'} size={26} color={cgu ? colors.primary : colors.muted} />
            <Text style={s.checkText}>{auth.signup.cgu}</Text>
          </Pressable>
          {errors.cgu ? (
            <View style={s.err} accessibilityLiveRegion="polite">
              <Icon name="alert-circle" size={16} color={colors.error} />
              <Text style={s.errText}>{errors.cgu}</Text>
            </View>
          ) : null}
          <Button label={auth.signup.cguLink} variant="ghost" onPress={() => router.push(routes.about)} />
        </View>
        {error ? <Banner tone="error" text={error.message} /> : null}
        <Button label={auth.signup.submit} onPress={() => void submit()} loading={busy} disabled={!configured || busy} />
        <Text style={s.note}>{auth.signup.note}</Text>
        <View style={formStyles.links}>
          <Button label={auth.signup.haveAccount} variant="ghost" onPress={() => router.replace(routes.login)} />
          <GuestExit entered={entered} />
        </View>
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  check: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: touch.min },
  checkText: { color: colors.text, fontSize: font.body, flexShrink: 1 },
  err: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  errText: { color: colors.error, fontSize: font.small, flexShrink: 1 },
  note: { color: colors.muted, fontSize: font.small, textAlign: 'center' },
});
