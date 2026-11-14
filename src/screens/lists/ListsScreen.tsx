// C3 — Listes (EX_17): one row per list, create / rename / export / delete. No swipe gestures (D19).
import { useState, type ReactElement } from 'react';
import { Alert, FlatList, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { ListSummary } from '@/domain/types';
import { createList, deleteList, renameList } from '@/data/inventoryRepo';
import { LIST_NAME_MAX } from '@/domain/inventory/inventory';
import { useLists } from '@/hooks/useInventory';
import { routes } from '@/navigation/routes';
import { feedback } from '@/services/feedback';
import { BottomSheet } from '@/components/BottomSheet';
import { Button, IconButton } from '@/components/Button';
import { ListRow } from '@/components/ListRow';
import { Screen } from '@/components/Screen';
import { ErrorState, LoadingState } from '@/components/StateViews';
import { TextField } from '@/components/TextField';
import { colors, font, spacing } from '@/theme';
import { common } from '@/i18n/fr/common';
import { fmtCount, plural, tpl } from '@/i18n/format';
import { inventory as t } from '@/i18n/fr/inventory';
import { SHEET_SWAP_MS } from '@/screens/inventory/itemActions';

type NameForm = { mode: 'create' } | { mode: 'rename'; list: ListSummary };

function refsText(n: number): string {
  return tpl(plural(n, t.screen.refsOne, t.screen.refsOther), { n: fmtCount(n) });
}
function piecesText(n: number): string {
  return tpl(plural(n, t.screen.piecesOne, t.screen.piecesOther), { n: fmtCount(n) });
}

export default function ListsScreen(): ReactElement {
  const lists = useLists();
  const [form, setForm] = useState<NameForm | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actions, setActions] = useState<ListSummary | null>(null);

  const data = lists.data ?? [];
  const canDelete = data.length > 1;

  const openForm = (f: NameForm) => {
    setName(f.mode === 'rename' ? f.list.name : '');
    setError(null);
    setForm(f);
  };
  const closeForm = () => {
    setForm(null);
    setError(null);
  };

  const submit = async () => {
    if (!form || busy) return;
    setBusy(true);
    try {
      const res = form.mode === 'create' ? await createList(name) : await renameList(form.list.id, name);
      if (res.ok) {
        feedback.success();
        closeForm();
      } else {
        feedback.error();
        setError(res.error.message);
      }
    } catch {
      setError(common.errors.unknown);
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = (l: ListSummary) => {
    const message = l.refCount === 0
      ? tpl(t.lists.deleteConfirmEmpty, { name: l.name })
      : tpl(plural(l.refCount, t.lists.deleteConfirmOne, t.lists.deleteConfirm), { name: l.name, n: l.refCount });
    Alert.alert(t.lists.deleteTitle, message, [
      { text: common.actions.cancel, style: 'cancel' },
      {
        text: common.actions.delete,
        style: 'destructive',
        onPress: () => {
          deleteList(l.id)
            .then((res) => {
              if (res.ok) feedback.success();
              else {
                feedback.error();
                Alert.alert(t.lists.deleteTitle, res.error.message);
              }
            })
            .catch(() => Alert.alert(t.lists.deleteTitle, common.errors.unknown));
        },
      },
    ]);
  };

  const afterActions = (fn: () => void) => {
    setActions(null);
    setTimeout(fn, SHEET_SWAP_MS);
  };

  let body: ReactElement;
  if (lists.data === undefined && lists.error) body = <ErrorState error={lists.error} onRetry={lists.reload} />;
  else if (lists.data === undefined) body = <LoadingState label={t.lists.loading} />;
  else {
    body = (
      <FlatList
        data={data}
        keyExtractor={(l) => l.id}
        contentContainerStyle={s.content}
        renderItem={({ item }) => (
          <ListRow
            title={item.name}
            subtitle={tpl(t.lists.rowSubtitle, { refs: fmtCount(item.refCount), pieces: piecesText(item.pieceCount) })}
            accessibilityLabel={tpl(t.lists.rowA11y, {
              name: item.name, refs: refsText(item.refCount), pieces: piecesText(item.pieceCount),
            })}
            onPress={() => router.navigate(routes.inventory(item.id))}
            right={
              <IconButton
                icon="ellipsis-horizontal"
                label={tpl(t.lists.more, { name: item.name })}
                onPress={() => setActions(item)}
              />
            }
          />
        )}
      />
    );
  }

  return (
    <Screen
      title={t.lists.title}
      right={<IconButton icon="add" label={t.lists.add} onPress={() => openForm({ mode: 'create' })} />}
    >
      {body}
      <BottomSheet visible={actions !== null} onClose={() => setActions(null)} title={actions?.name}>
        {actions ? (
          <View style={s.sheet}>
            <Button
              label={t.lists.rename}
              icon="create-outline"
              variant="secondary"
              onPress={() => afterActions(() => openForm({ mode: 'rename', list: actions }))}
            />
            <Button
              label={t.lists.export}
              icon="share-outline"
              variant="secondary"
              onPress={() => afterActions(() => router.push(routes.exportSheet(actions.id)))}
            />
            <Button
              label={t.lists.delete}
              icon="trash-outline"
              variant="danger"
              disabled={!canDelete}
              accessibilityHint={canDelete ? undefined : t.lists.lastListHint}
              onPress={() => afterActions(() => confirmDelete(actions))}
            />
            {!canDelete ? <Text style={s.hint}>{t.lists.lastListHint}</Text> : null}
          </View>
        ) : null}
      </BottomSheet>
      <BottomSheet
        visible={form !== null}
        onClose={closeForm}
        title={form?.mode === 'rename' ? t.lists.renameTitle : t.lists.createTitle}
      >
        <View style={s.sheet}>
          <TextField
            label={t.lists.nameLabel}
            placeholder={t.lists.namePlaceholder}
            value={name}
            onChangeText={(v) => {
              setName(v);
              if (error) setError(null);
            }}
            error={error}
            maxLength={LIST_NAME_MAX + 20}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={() => void submit()}
          />
          <Button
            label={form?.mode === 'rename' ? t.lists.save : t.lists.create}
            loading={busy}
            disabled={name.trim() === ''}
            onPress={() => void submit()}
          />
        </View>
      </BottomSheet>
    </Screen>
  );
}

const s = StyleSheet.create({
  content: { paddingBottom: spacing.xl },
  sheet: { gap: spacing.md },
  hint: { color: colors.muted, fontSize: font.small },
});
