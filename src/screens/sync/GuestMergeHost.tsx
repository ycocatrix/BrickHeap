// Mounted once in the root layout (WP0). Renders the RG_11 guest-merge prompt (state 'merge_pending') and the
// other-account prompt (state 'account_mismatch'). Renders nothing otherwise.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { AccessibilityInfo, Alert, StyleSheet, Text, View } from 'react-native';
import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { mergePromptStore, resolveAccountMismatch, resolveGuestMerge, useSyncStatus } from '@/services/sync';
import { useStore } from '@/state/createStore';
import { plural, tpl } from '@/i18n/format';
import { sync as t } from '@/i18n/fr/sync';
import { colors, font, spacing } from '@/theme';

const selectRefs = (s: { localRefs: number }): number => s.localRefs;

export function GuestMergeHost(): ReactElement | null {
  const status = useSyncStatus();
  const localRefs = useStore(mergePromptStore, selectRefs);
  const [busy, setBusy] = useState<null | 'merge' | 'keep_account' | 'cancel'>(null);
  const mismatchShown = useRef(false);

  const merging = status.state === 'merge_pending';
  const message = tpl(plural(localRefs, t.merge.messageOne, t.merge.messageOther), { n: localRefs });

  useEffect(() => {
    if (merging) AccessibilityInfo.announceForAccessibility(`${t.merge.title} ${message}`);
  }, [merging, message]);

  // Other-account prompt: a native Alert (three choices, not dismissable on Android), shown once per entry.
  useEffect(() => {
    if (status.state !== 'account_mismatch') {
      mismatchShown.current = false;
      return;
    }
    if (mismatchShown.current) return;
    mismatchShown.current = true;
    Alert.alert(
      t.mismatch.title,
      t.mismatch.message,
      [
        { text: t.mismatch.replace, style: 'destructive', onPress: () => void resolveAccountMismatch('replace') },
        { text: t.mismatch.keepAsGuest, onPress: () => void resolveAccountMismatch('keep_as_guest') },
        { text: t.mismatch.cancel, style: 'cancel', onPress: () => void resolveAccountMismatch('cancel') },
      ],
      { cancelable: false },
    );
  }, [status.state]);

  if (!merging) return null;

  const choose = (choice: 'merge' | 'keep_account' | 'cancel'): void => {
    setBusy(choice);
    void resolveGuestMerge(choice).finally(() => setBusy(null));
  };
  const confirmKeepAccount = (): void => {
    Alert.alert(t.merge.confirmTitle, t.merge.confirmMessage, [
      { text: t.merge.cancel, style: 'cancel' },
      { text: t.merge.confirmAction, style: 'destructive', onPress: () => choose('keep_account') },
    ]);
  };

  return (
    // The sheet stays open on backdrop press / Android back: « Annuler » is the explicit way out.
    <BottomSheet visible onClose={() => undefined} title={t.merge.title}>
      <View style={styles.body}>
        <View style={styles.row} accessible accessibilityRole="text" accessibilityLabel={message}>
          <Icon name="git-merge-outline" size={24} color={colors.primary} />
          <Text style={styles.message}>{message}</Text>
        </View>
        {status.error ? (
          <View style={styles.row} accessibilityLiveRegion="polite">
            <Icon name="alert-circle" size={20} color={colors.error} />
            <Text style={styles.error}>{status.error.message}</Text>
          </View>
        ) : null}
        <Button label={t.merge.merge} icon="git-merge-outline" onPress={() => choose('merge')}
          loading={busy === 'merge'} disabled={busy !== null} />
        <Button label={t.merge.keepAccount} variant="secondary" onPress={confirmKeepAccount}
          loading={busy === 'keep_account'} disabled={busy !== null} />
        <Button label={t.merge.cancel} variant="ghost" onPress={() => choose('cancel')}
          accessibilityHint={t.merge.cancelHint} loading={busy === 'cancel'} disabled={busy !== null} />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.md, paddingVertical: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  message: { flex: 1, color: colors.text, fontSize: font.body },
  error: { flex: 1, color: colors.error, fontSize: font.small },
});
