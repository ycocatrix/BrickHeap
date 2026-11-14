// Colour / category filter sheet of the inventory (EX_15).
import type { ReactElement } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ColorId } from '@/domain/types';
import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { ColorDot } from '@/components/ColorDot';
import { colors, font, spacing } from '@/theme';
import { common } from '@/i18n/fr/common';
import { inventory as t } from '@/i18n/fr/inventory';

export interface ColorOption { id: ColorId; label: string; hex: string | null; isTrans: boolean }
export interface CategoryOption { id: number; label: string }

export function FilterSheet(p: {
  mode: 'color' | 'category' | null;
  onClose: () => void;
  colorOptions: ColorOption[];
  categoryOptions: CategoryOption[];
  colorIds: ColorId[];
  categoryIds: number[];
  onToggleColor: (id: ColorId) => void;
  onToggleCategory: (id: number) => void;
  onClear: () => void;
}): ReactElement {
  const isColor = p.mode === 'color';
  const options = isColor ? p.colorOptions : p.categoryOptions;
  return (
    <BottomSheet
      visible={p.mode !== null}
      onClose={p.onClose}
      title={isColor ? t.filters.colorTitle : t.filters.categoryTitle}
    >
      <ScrollView style={s.scroll} contentContainerStyle={s.chips}>
        {options.length === 0 ? <Text style={s.none}>{t.filters.none}</Text> : null}
        {isColor
          ? p.colorOptions.map((o) => (
              <View key={o.id} style={s.colorChip}>
                <ColorDot hex={o.hex} isTrans={o.isTrans} size={14} />
                <Chip label={o.label} selected={p.colorIds.includes(o.id)} onPress={() => p.onToggleColor(o.id)} />
              </View>
            ))
          : p.categoryOptions.map((o) => (
              <Chip
                key={o.id}
                label={o.label}
                selected={p.categoryIds.includes(o.id)}
                onPress={() => p.onToggleCategory(o.id)}
              />
            ))}
      </ScrollView>
      <View style={s.actions}>
        <Button label={t.filters.clear} variant="ghost" onPress={p.onClear} style={s.action} />
        <Button label={common.actions.close} onPress={p.onClose} style={s.action} />
      </View>
    </BottomSheet>
  );
}

const s = StyleSheet.create({
  scroll: { maxHeight: 360 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingVertical: spacing.sm },
  colorChip: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  none: { color: colors.muted, fontSize: font.body },
  actions: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.md },
  action: { flex: 1 },
});
