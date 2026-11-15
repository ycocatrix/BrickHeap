// New password after a recovery code or link (EX_22). The recovery session exists at this point.
import type { ReactElement } from 'react';
import { StyleSheet, Text } from 'react-native';
import { Screen } from '@/components/Screen';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { auth } from '@/i18n/fr/auth';
import { routes } from '@/navigation/routes';
import { useSession } from '@/state/session';
import { PasswordForm } from '@/screens/account/PasswordForm';
import { colors, font, spacing } from '@/theme';
import { goBack, goHome } from './authUi';
import { router } from 'expo-router';

export default function NewPasswordScreen(): ReactElement {
  const { configured, user } = useSession();
  return (
    <Screen title={auth.newPassword.title} onBack={() => goBack(routes.login)} scroll>
      {!configured ? (
        <Banner tone="info" text={auth.notConfiguredHelp} />
      ) : !user ? (
        <>
          <Banner tone="error" text={auth.errors.linkInvalid} />
          <Button label={auth.callback.signIn} onPress={() => router.replace(routes.login)} />
        </>
      ) : (
        <>
          <Text style={s.intro}>{auth.newPassword.intro}</Text>
          <PasswordForm onDone={goHome} />
        </>
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  intro: { color: colors.muted, fontSize: font.body, paddingTop: spacing.md },
});
