// New password + confirmation → updatePassword. Shared by PasswordScreen and NewPasswordScreen. Not a route.
import { useState, type ReactElement } from 'react';
import { View } from 'react-native';
import { Button } from '@/components/Button';
import { TextField } from '@/components/TextField';
import { Banner } from '@/components/Banner';
import type { AppError } from '@/domain/types';
import { validatePassword } from '@/domain/auth/validation';
import { auth } from '@/i18n/fr/auth';
import { account } from '@/i18n/fr/account';
import { updatePassword } from '@/services/auth';
import { formStyles } from '@/screens/auth/authUi';

export function PasswordForm(p: { onDone: () => void; disabled?: boolean }): ReactElement {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ password: string | null; confirm: string | null }>({ password: null, confirm: null });
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const next = {
      password: validatePassword(password),
      confirm: confirm !== password ? auth.validation.passwordMismatch : null,
    };
    setErrors(next);
    setError(null);
    if (next.password || next.confirm) return;
    setBusy(true);
    const r = await updatePassword(password);
    setBusy(false);
    if (r.ok) {
      setPassword('');
      setConfirm('');
      p.onDone();
      return;
    }
    if (r.error.cause === 'weak_password' || r.error.code === 'invalid') setErrors({ ...next, password: r.error.message });
    else setError(r.error);
  };

  return (
    <View style={formStyles.form}>
      <TextField
        label={account.password.newPassword}
        value={password}
        onChangeText={setPassword}
        error={errors.password}
        secure
        autoCapitalize="none"
        autoComplete="new-password"
        textContentType="newPassword"
      />
      <TextField
        label={account.password.confirm}
        value={confirm}
        onChangeText={setConfirm}
        error={errors.confirm}
        secure
        autoCapitalize="none"
        autoComplete="new-password"
        textContentType="newPassword"
        returnKeyType="done"
        onSubmitEditing={() => void submit()}
      />
      {error ? <Banner tone="error" text={error.message} /> : null}
      <Button label={account.password.submit} onPress={() => void submit()} loading={busy} disabled={p.disabled || busy} />
    </View>
  );
}
