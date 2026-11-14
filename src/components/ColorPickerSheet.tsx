import { useMemo, useState, type ReactElement } from 'react';
import { Pressable, SectionList, StyleSheet, Text, TextInput, View } from 'react-native';
import type { CatalogColor, ColorId } from '@/domain/types';
import { COMMON_OPAQUE_COLOR_IDS } from '@/domain/vision/color';
import { colors as theme, font, radius, spacing, touch } from '@/theme';
import { colorLabel } from '@/i18n/fr/colors';
import { tpl } from '@/i18n/format';
import { ui } from '@/i18n/fr/ui';
import { BottomSheet } from './BottomSheet';
import { ColorDot } from './ColorDot';
import { Icon } from './Icon';
import { PartImage } from './PartImage';
import { normalizeSearch } from './quantity';

interface Section {
  key: string;
  title: string;
  data: CatalogColor[];
}

/** Rebrickable pseudo-colours ([Unknown] -1, [No Color/Any Color] 9999) are never offered. */
const isRealColor = (c: CatalogColor) => c.colorId >= 0 && c.colorId !== 9999;

/** Sections: suggestions · couleurs courantes (COMMON_OPAQUE_COLOR_IDS) · toutes; search by FR/EN name; dot + name
 *  rows. Calls onSelect only: the caller closes the sheet. */
export function ColorPickerSheet(p: {
  visible: boolean;
  onClose: () => void;
  colors: CatalogColor[];
  /** shown first under « Suggestions » */
  suggested?: ColorId[];
  selected?: ColorId | null;
  onSelect: (colorId: ColorId) => void;
  /** Photo of the real piece (IdentifiedPiece.cropUri), shown at the top, next to the measured swatch. */
  referenceUri?: string | null;
  /** Detection.rgb as hex, « Couleur mesurée » swatch. */
  measuredHex?: string | null;
}): ReactElement {
  const [query, setQuery] = useState('');
  const sections = useMemo(
    () => buildSections(p.colors, p.suggested ?? [], normalizeSearch(query)),
    [p.colors, p.suggested, query],
  );
  const hasReference = !!p.referenceUri || !!p.measuredHex;

  const close = () => {
    setQuery('');
    p.onClose();
  };

  return (
    <BottomSheet visible={p.visible} onClose={close} title={ui.colorPicker.title}>
      {hasReference ? (
        <View style={s.reference}>
          {p.referenceUri ? (
            <PartImage uri={p.referenceUri} size={72} accessibilityLabel={ui.colorPicker.reference} />
          ) : null}
          {p.measuredHex ? (
            <View style={s.measured} accessible accessibilityLabel={ui.colorPicker.measured}>
              <ColorDot hex={p.measuredHex} size={32} />
              <Text style={s.measuredText}>{ui.colorPicker.measured}</Text>
            </View>
          ) : null}
        </View>
      ) : null}
      <View style={s.search}>
        <Icon name="search" size={18} color={theme.muted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={ui.colorPicker.search}
          placeholderTextColor={theme.muted}
          accessibilityLabel={ui.colorPicker.searchLabel}
          autoCorrect={false}
          returnKeyType="search"
          selectionColor={theme.primary}
          style={s.searchInput}
        />
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(c, i) => `${c.colorId}-${i}`}
        stickySectionHeadersEnabled={false}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={20}
        style={s.list}
        renderSectionHeader={({ section }) => (
          <Text style={s.sectionTitle} accessibilityRole="header">
            {section.title}
          </Text>
        )}
        renderItem={({ item }) => (
          <ColorRow color={item} selected={item.colorId === p.selected} onPress={() => p.onSelect(item.colorId)} />
        )}
        ListEmptyComponent={<Text style={s.empty}>{tpl(ui.colorPicker.empty, { query: query.trim() })}</Text>}
      />
    </BottomSheet>
  );
}

function ColorRow(p: { color: CatalogColor; selected: boolean; onPress: () => void }): ReactElement {
  const fr = colorLabel(p.color);
  const showEn = normalizeSearch(fr) !== normalizeSearch(p.color.name);
  const a11y = [fr, p.color.isTrans ? ui.colorPicker.transparent : null, p.selected ? ui.colorPicker.selected : null]
    .filter(Boolean)
    .join(', ');
  return (
    <Pressable
      onPress={p.onPress}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ selected: p.selected }}
      style={({ pressed }) => [s.row, p.selected && s.rowSelected, pressed && s.pressed]}
    >
      <ColorDot hex={p.color.hex} isTrans={p.color.isTrans} size={24} />
      <View style={s.rowTexts}>
        <Text style={[s.rowTitle, p.selected && s.bold]}>{fr}</Text>
        {showEn ? <Text style={s.rowSub}>{p.color.name}</Text> : null}
      </View>
      {p.selected ? <Icon name="checkmark" size={22} color={theme.primary} /> : null}
    </Pressable>
  );
}

function buildSections(all: CatalogColor[], suggested: readonly ColorId[], q: string): Section[] {
  const real = all.filter(isRealColor);
  const byId = new Map(real.map((c) => [c.colorId, c] as const));
  if (q) {
    const hits = real
      .filter((c) => normalizeSearch(colorLabel(c)).includes(q) || normalizeSearch(c.name).includes(q))
      .sort(byLabel);
    return hits.length ? [{ key: 'results', title: ui.colorPicker.results, data: hits }] : [];
  }
  const pick = (ids: readonly ColorId[], skip: Set<ColorId>) => {
    const out: CatalogColor[] = [];
    for (const id of ids) {
      const c = byId.get(id);
      if (c && !skip.has(id)) {
        out.push(c);
        skip.add(id);
      }
    }
    return out;
  };
  const used = new Set<ColorId>();
  const sug = pick(suggested, used);
  const common = pick(COMMON_OPAQUE_COLOR_IDS, used);
  const sections: Section[] = [];
  if (sug.length) sections.push({ key: 'suggestions', title: ui.colorPicker.suggestions, data: sug });
  if (common.length) sections.push({ key: 'common', title: ui.colorPicker.common, data: common });
  sections.push({ key: 'all', title: ui.colorPicker.all, data: [...real].sort(byLabel) });
  return sections;
}

function byLabel(a: CatalogColor, b: CatalogColor): number {
  const la = normalizeSearch(colorLabel(a));
  const lb = normalizeSearch(colorLabel(b));
  return la < lb ? -1 : la > lb ? 1 : a.colorId - b.colorId;
}

const s = StyleSheet.create({
  reference: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, marginBottom: spacing.md },
  measured: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  measuredText: { color: theme.text, fontSize: font.small },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: touch.min,
    paddingHorizontal: spacing.md,
    backgroundColor: theme.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: theme.line,
  },
  searchInput: { flex: 1, color: theme.text, fontSize: font.body, paddingVertical: spacing.sm },
  list: { flexShrink: 1, marginTop: spacing.sm },
  sectionTitle: {
    color: theme.muted,
    fontSize: font.small,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: touch.min,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.sm,
  },
  rowSelected: { backgroundColor: theme.surface },
  pressed: { opacity: 0.7 },
  rowTexts: { flex: 1 },
  rowTitle: { color: theme.text, fontSize: font.body },
  bold: { fontWeight: '700' },
  rowSub: { color: theme.muted, fontSize: font.small },
  empty: { color: theme.muted, fontSize: font.body, textAlign: 'center', paddingVertical: spacing.xl },
});
