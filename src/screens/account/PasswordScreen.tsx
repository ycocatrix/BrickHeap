// Change password (signed in, EX_23).
import { useState, type ReactElement } from 'react';
import { router } from 'expo-router';
import { Screen } from '@/components/Screen';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { account } from '@/i18n/fr/account';
import { auth } from '@/i18n/fr/auth';
import { common } from '@/i18n/fr/common';
import { routes } from '@/navigation/routes';
import { useSession } from '@/state/session';
import { goBack } from '@/screens/auth/authUi';
import { PasswordForm } from './PasswordForm';

export default function PasswordScreen(): ReactElement {
  const { user, configured } = useSession();
  const [done, setDone] = useState(false);
  return (
    <Screen title={account.password.title} onBack={() => goBack(routes.account)} scroll>
      {!configured ? (
        <Banner tone="info" text={auth.notConfiguredHelp} />
      ) : !user ? (
        <>
          <Banner tone="info" text={auth.errors.notSignedIn} />
          <Button label={auth.welcome.signIn} onPress={() => router.push(routes.login)} />
        </>
      ) : done ? (
        <>
          <Banner tone="ok" text={account.password.saved} />
          <Button label={common.actions.back} variant="secondary" onPress={() => goBack(routes.account)} />
        </>
      ) : (
        <PasswordForm onDone={() => setDone(true)} />
      )}
    </Screen>
  );
}
