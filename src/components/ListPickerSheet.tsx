import { useState, type ReactElement } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import type { List, ListId, ListSummary, Result } from '@/domain/types';
import { colors, spacing } from '@/theme';
import { common } from '@/i18n/fr/common';
import { plural, tpl } from '@/i18n/format';
import { ui } from '@/i18n/fr/ui';
import { BottomSheet } from './BottomSheet';
import { Button } from './Button';
import { Icon } from './Icon';
import { ListRow } from './ListRow';
import { TextField } from './TextField';

/** Lists with their counts, then an inline « Nouvelle liste » field. A successfully created list is selected
 *  (onSelect is called with its id). The caller closes the sheet in onSelect. */
export function ListPickerSheet(p: {
  visible: boolean;
  onClose: () => void;
  lists: ListSummary[];
  selectedId?: ListId | null;
  onSelect: (id: ListId) => void;
  /** inline « Nouvelle liste » field; error message shown under it */
  onCreate: (name: string) => Promise<Result<List>>;
}): ReactElement {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setName('');
    setError(null);
    p.onClose();
  };

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(ui.listPicker.emptyName);
      return;
    }
    setBusy(true);
    setError(null);
    let res: Result<List>;
    try {
      res = await p.onCreate(trimmed);
    } catch {
      res = { ok: false, error: { code: 'unknown', message: common.errors.unknown } };
    }
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    setName('');
    p.onSelect(res.value.id);
  };

  return (
    <BottomSheet visible={p.visible} onClose={close} title={ui.listPicker.title}>
      <ScrollView keyboardShouldPersistTaps="handled" style={s.scroll}>
        {p.lists.map((l) => {
          const selected = l.id === p.selectedId;
          const subtitle = tpl(ui.listPicker.counts, {
            refs: tpl(plural(l.refCount, ui.listPicker.refOne, ui.listPicker.refOther), { n: l.refCount }),
            pieces: tpl(plural(l.pieceCount, ui.listPicker.pieceOne, ui.listPicker.pieceOther), { n: l.pieceCount }),
          });
          return (
            <ListRow
              key={l.id}
              title={l.name}
              subtitle={subtitle}
              left={<Icon name="list-outline" size={22} color={selected ? colors.primary : colors.muted} />}
              right={selected ? <Icon name="checkmark" size={22} color={colors.primary} /> : null}
              accessibilityLabel={[l.name, subtitle, selected ? ui.listPicker.selected : null].filter(Boolean).join(', ')}
              onPress={() => p.onSelect(l.id)}
            />
          );
        })}
        <View style={s.create}>
          <TextField
            label={ui.listPicker.newList}
            placeholder={ui.listPicker.newListPlaceholder}
            value={name}
            onChangeText={(t) => {
              setName(t);
              if (error) setError(null);
            }}
            error={error}
            maxLength={60}
            returnKeyType="done"
            onSubmitEditing={create}
            editable={!busy}
          />
          <Button label={ui.listPicker.create} icon="add" variant="secondary" loading={busy} onPress={create} />
        </View>
      </ScrollView>
    </BottomSheet>
  );
}

const s = StyleSheet.create({
  scroll: { flexShrink: 1 },
  create: { marginTop: spacing.lg, marginBottom: spacing.sm },
});
