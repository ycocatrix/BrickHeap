// A6 — Réglages (EX_10, EX_23). The mockup's « Sync Wi-Fi uniquement » row is dropped (§8.2).
import { useState, type ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@/components/Screen';
import { Banner } from '@/components/Banner';
import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { ListRow } from '@/components/ListRow';
import { SwitchRow } from '@/components/SwitchRow';
import { TextField } from '@/components/TextField';
import type { AppError } from '@/domain/types';
import { account } from '@/i18n/fr/account';
import { routes } from '@/navigation/routes';
import { deleteAccount } from '@/services/auth';
import { setSetting, useSetting } from '@/state/settings';
import { useSession } from '@/state/session';
import { goBack, goWelcome } from '@/screens/auth/authUi';
import { colors, font, spacing } from '@/theme';

const SHEET_CLOSE_MS = 350;

function DeleteAccountSheet(p: { visible: boolean; onClose: () => void }): ReactElement {
  const [word, setWord] = useState('');
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const matches = word.trim().toUpperCase() === account.deleteSheet.word;

  const close = (): void => {
    if (busy) return;
    setWord('');
    setError(null);
    p.onClose();
  };

  const exportFirst = (): void => {
    close();
    // Let the RN Modal finish closing before presenting the export formSheet (iOS refuses overlapping modals).
    setTimeout(() => router.push(routes.exportSheet(null)), SHEET_CLOSE_MS);
  };

  const submit = async (): Promise<void> => {
    if (!matches) return;
    setBusy(true);
    setError(null);
    const r = await deleteAccount();
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setWord('');
    p.onClose();
    goWelcome();
  };

  return (
    <BottomSheet visible={p.visible} onClose={close} title={account.deleteSheet.title}>
      <View style={s.sheet}>
        <View style={s.warnRow}>
          <Icon name="warning-outline" size={22} color={colors.error} />
          <Text style={s.sheetText}>{account.deleteSheet.text}</Text>
        </View>
        <Button label={account.deleteSheet.exportFirst} icon="download-outline" variant="ghost" onPress={exportFirst} />
        <TextField
          label={account.deleteSheet.fieldLabel}
          value={word}
          onChangeText={setWord}
          autoCapitalize="characters"
          autoCorrect={false}
          placeholder={account.deleteSheet.word}
        />
        {error ? <Banner tone="error" text={error.message} /> : null}
        <Button
          label={account.deleteSheet.submit}
          variant="danger"
          onPress={() => void submit()}
          loading={busy}
          disabled={!matches || busy}
        />
      </View>
    </BottomSheet>
  );
}

export default function SettingsScreen(): ReactElement {
  const { user, configured } = useSession();
  const torch = useSetting('torchOnLaunch');
  const haptics = useSetting('haptics');
  const live = useSetting('liveExplorer');
  const calibrationOn = useSetting('calibration');
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <Screen title={account.settings.title} onBack={() => goBack(routes.account)} scroll>
      <View style={s.content}>
        <ListRow
          title={account.settings.language}
          subtitle={account.settings.languageHint}
          left={<Icon name="globe-outline" size={22} color={colors.muted} />}
          right={<Text style={s.value}>{account.settings.languageValue}</Text>}
          accessibilityLabel={`${account.settings.language}, ${account.settings.languageValue}. ${account.settings.languageHint}`}
        />
        <SwitchRow
          label={account.settings.torch}
          hint={account.settings.torchHint}
          value={torch}
          onValueChange={(v) => setSetting('torchOnLaunch', v)}
        />
        <SwitchRow
          label={account.settings.haptics}
          hint={account.settings.hapticsHint}
          value={haptics}
          onValueChange={(v) => setSetting('haptics', v)}
        />
        <SwitchRow
          label={account.settings.live}
          hint={account.settings.liveHint}
          value={live}
          onValueChange={(v) => setSetting('liveExplorer', v)}
        />
        <SwitchRow
          label={account.settings.calibration}
          hint={account.settings.calibrationHint}
          value={calibrationOn}
          onValueChange={(v) => setSetting('calibration', v)}
        />
        {calibrationOn ? (
          <ListRow
            title={account.settings.openCalibration}
            left={<Icon name="flask-outline" size={22} color={colors.muted} />}
            right={<Icon name="chevron-forward" size={20} color={colors.muted} />}
            onPress={() => router.push(routes.calibration)}
          />
        ) : null}
        <ListRow
          title={account.settings.privacy}
          left={<Icon name="lock-closed-outline" size={22} color={colors.muted} />}
          right={<Icon name="chevron-forward" size={20} color={colors.muted} />}
          onPress={() => router.push(routes.about)}
        />
        {user && configured ? (
          <View style={s.danger}>
            <ListRow
              title={account.settings.deleteAccount}
              subtitle={account.settings.deleteAccountHint}
              left={<Icon name="trash-outline" size={22} color={colors.error} />}
              destructive
              onPress={() => setDeleteOpen(true)}
            />
          </View>
        ) : null}
      </View>
      <DeleteAccountSheet visible={deleteOpen} onClose={() => setDeleteOpen(false)} />
    </Screen>
  );
}

const s = StyleSheet.create({
  content: { paddingBottom: spacing.xl },
  value: { color: colors.muted, fontSize: font.body },
  danger: { marginTop: spacing.xl },
  sheet: { gap: spacing.md },
  warnRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  sheetText: { color: colors.text, fontSize: font.body, flexShrink: 1 },
});
