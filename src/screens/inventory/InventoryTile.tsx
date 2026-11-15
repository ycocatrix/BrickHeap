// Inventory grid tile and list row (EX_15): image with the quantity badge on its top-right corner, French name,
// colour dot + colour name, « ⋯ » actions button (non-gesture alternative to the long-press).
import type { ReactElement } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { InventoryRow } from '@/domain/types';
import { rowColorName, rowName } from '@/domain/inventory/inventory';
import { ColorDot } from '@/components/ColorDot';
import { IconButton } from '@/components/Button';
import { ListRow } from '@/components/ListRow';
import { PartImage } from '@/components/PartImage';
import { QuantityBadge } from '@/components/QuantityBadge';
import { colors, font, spacing } from '@/theme';
import { fmtCount, tpl } from '@/i18n/format';
import { inventory as t } from '@/i18n/fr/inventory';

interface Props {
  row: InventoryRow;
  onOpen: (row: InventoryRow) => void;
  onActions: (row: InventoryRow) => void;
}

function cue(row: InventoryRow): { hex: string; isTrans: boolean } | null {
  if (row.coloredImage || !row.color) return null;
  return { hex: row.color.hex, isTrans: row.color.isTrans };
}

export function tileLabel(row: InventoryRow): string {
  return tpl(t.screen.tileA11y, { name: rowName(row), color: rowColorName(row), n: row.quantity });
}

export function InventoryTile(p: Props & { width: number }): ReactElement {
  const { row } = p;
  const name = rowName(row);
  return (
    <View style={[s.tile, { width: p.width }]}>
      <Pressable
        onPress={() => p.onOpen(row)}
        onLongPress={() => p.onActions(row)}
        accessibilityRole="button"
        accessibilityLabel={tileLabel(row)}
        accessibilityHint={t.screen.tileHint}
        style={({ pressed }) => [pressed && s.pressed]}
      >
        <View>
          <PartImage uri={row.imageUrl} size={p.width} colorCue={cue(row)} />
          <View style={s.badge} pointerEvents="none">
            <QuantityBadge quantity={row.quantity} />
          </View>
        </View>
        <Text style={s.name} numberOfLines={2}>
          {name}
        </Text>
      </Pressable>
      <View style={s.colorRow}>
        <View style={s.colorInfo} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          <ColorDot hex={row.color?.hex ?? null} isTrans={row.color?.isTrans} size={12} />
          <Text style={s.colorName} numberOfLines={1}>
            {rowColorName(row)}
          </Text>
        </View>
        <IconButton
          icon="ellipsis-horizontal"
          label={tpl(t.screen.moreActions, { name })}
          onPress={() => p.onActions(row)}
          size={20}
        />
      </View>
    </View>
  );
}

export function InventoryListItem(p: Props & { showList: boolean }): ReactElement {
  const { row } = p;
  const name = rowName(row);
  const subtitle = p.showList ? `${rowColorName(row)} · ${row.listName}` : rowColorName(row);
  return (
    <ListRow
      title={name}
      subtitle={subtitle}
      onPress={() => p.onOpen(row)}
      accessibilityLabel={tileLabel(row)}
      left={
        <View>
          <PartImage uri={row.imageUrl} size={48} colorCue={cue(row)} />
        </View>
      }
      right={
        <View style={s.listRight}>
          <Text style={s.qty} importantForAccessibility="no" accessibilityElementsHidden>
            {tpl(t.screen.quantityShort, { n: fmtCount(row.quantity) })}
          </Text>
          <IconButton
            icon="ellipsis-horizontal"
            label={tpl(t.screen.moreActions, { name })}
            onPress={() => p.onActions(row)}
            size={20}
          />
        </View>
      }
    />
  );
}

const s = StyleSheet.create({
  tile: { marginBottom: spacing.md },
  pressed: { opacity: 0.7 },
  badge: { position: 'absolute', top: spacing.xs, right: spacing.xs },
  name: { color: colors.text, fontSize: font.small, fontWeight: '600', marginTop: spacing.xs },
  colorRow: { flexDirection: 'row', alignItems: 'center' },
  colorInfo: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minWidth: 0 },
  colorName: { color: colors.muted, fontSize: font.tiny, flexShrink: 1 },
  listRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  qty: { color: colors.primary, fontSize: font.body, fontWeight: '700' },
});
