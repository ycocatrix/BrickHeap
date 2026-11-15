// C2 / C5 — Inventaire (EX_15, EX_16): list chips, search, colour / category filters, grouping, grid or list view,
// item actions (quantity, move, delete with undo), export entry.
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { ScrollView, SectionList, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type { ColorId, InventoryGroupBy, InventoryRow, InventorySection, ItemRef } from '@/domain/types';
import { filterAndGroup, inventoryTotals, rowColorName, rowName } from '@/domain/inventory/inventory';
import { categoryLabel } from '@/domain/catalog/partInfo';
import { itemKey } from '@/domain/keys';
import { createList } from '@/data/inventoryRepo';
import { hydrateParts } from '@/services/catalog';
import { useInventory, useLists } from '@/hooks/useInventory';
import { useSession } from '@/state/session';
import { setSetting, useSetting } from '@/state/settings';
import { routes } from '@/navigation/routes';
import { Banner } from '@/components/Banner';
import { BottomSheet } from '@/components/BottomSheet';
import { Button, IconButton } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { ListPickerSheet } from '@/components/ListPickerSheet';
import { QuantityStepper } from '@/components/QuantityStepper';
import { Screen } from '@/components/Screen';
import { SegmentedControl } from '@/components/SegmentedControl';
import { EmptyState, ErrorState, Skeleton } from '@/components/StateViews';
import { TextField } from '@/components/TextField';
import { colors, font, spacing } from '@/theme';
import { fmtCount, plural, tpl } from '@/i18n/format';
import { inventory as t } from '@/i18n/fr/inventory';
import { FilterSheet, type CategoryOption, type ColorOption } from './FilterSheet';
import { InventoryListItem, InventoryTile } from './InventoryTile';
import { changeQuantity, moveWithUndo, removeWithUndo, SHEET_SWAP_MS } from './itemActions';

const GAP = spacing.md;
const PAD = spacing.lg; // = <Screen> body horizontal padding
const TILE_MIN = 120;

type Entry = { kind: 'grid'; key: string; rows: InventoryRow[] } | { kind: 'row'; key: string; row: InventoryRow };
type Section = { key: string; title: string; data: Entry[] };

const rowKey = (r: ItemRef): string => `${r.listId}|${itemKey(r.partId, r.colorId)}`;
const refOf = (r: InventoryRow): ItemRef => ({ listId: r.listId, partId: r.partId, colorId: r.colorId });

function toSections(sections: InventorySection[], grid: boolean, columns: number): Section[] {
  return sections.map((s) => {
    if (!grid) return { key: s.key, title: s.title, data: s.rows.map((row) => ({ kind: 'row', key: rowKey(row), row })) };
    const data: Entry[] = [];
    for (let i = 0; i < s.rows.length; i += columns) {
      const chunk = s.rows.slice(i, i + columns);
      data.push({ kind: 'grid', key: chunk.map(rowKey).join(','), rows: chunk });
    }
    return { key: s.key, title: s.title, data };
  });
}

export default function InventoryScreen(): ReactElement {
  const params = useLocalSearchParams<{ listId?: string }>();
  const listId = typeof params.listId === 'string' && params.listId !== '' ? params.listId : null;
  const { width } = useWindowDimensions();
  const view = useSetting('inventoryView');
  const session = useSession();
  const lists = useLists();
  const inv = useInventory(listId);

  const [query, setQuery] = useState('');
  const [colorIds, setColorIds] = useState<ColorId[]>([]);
  const [categoryIds, setCategoryIds] = useState<number[]>([]);
  const [groupBy, setGroupBy] = useState<InventoryGroupBy>('none');
  const [filterMode, setFilterMode] = useState<'color' | 'category' | null>(null);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [moveRow, setMoveRow] = useState<InventoryRow | null>(null);
  const [guestDismissed, setGuestDismissed] = useState(false);

  const rows = useMemo(() => inv.data ?? [], [inv.data]);
  const grid = view === 'grid';
  const columns = Math.max(2, Math.floor(width / TILE_MIN));
  const tileWidth = Math.floor((width - PAD * 2 - GAP * (columns - 1)) / columns);

  // A list deleted elsewhere (Listes tab) falls back to « Tout ».
  useEffect(() => {
    if (listId && lists.data && !lists.data.some((l) => l.id === listId)) router.setParams({ listId: '' });
  }, [listId, lists.data]);

  // Hydrate catalogue data (names, coloured images) for the parts shown; hydrateParts never rejects.
  const partIdsKey = useMemo(() => [...new Set(rows.map((r) => r.partId))].sort().join('\n'), [rows]);
  useEffect(() => {
    if (!partIdsKey) return;
    Promise.resolve()
      .then(() => hydrateParts(partIdsKey.split('\n')))
      .catch(() => undefined);
  }, [partIdsKey]);

  const sections = useMemo(
    () => filterAndGroup(rows, { listId: null, query, colorIds, categoryIds, groupBy }),
    [rows, query, colorIds, categoryIds, groupBy],
  );
  const shown = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const totals = inventoryTotals(shown);
  const listSections = useMemo(() => toSections(sections, grid, columns), [sections, grid, columns]);

  const colorOptions = useMemo<ColorOption[]>(() => {
    const m = new Map<ColorId, ColorOption>();
    for (const r of rows) {
      if (!m.has(r.colorId)) {
        m.set(r.colorId, { id: r.colorId, label: rowColorName(r), hex: r.color?.hex ?? null, isTrans: !!r.color?.isTrans });
      }
    }
    return [...m.values()].sort((a, b) => a.label.localeCompare(b.label, 'fr'));
  }, [rows]);
  const categoryOptions = useMemo<CategoryOption[]>(() => {
    const m = new Map<number, CategoryOption>();
    for (const r of rows) {
      const id = r.part?.categoryId;
      if (id == null || m.has(id)) continue;
      m.set(id, { id, label: r.categoryName ?? categoryLabel(id, null) ?? String(id) });
    }
    return [...m.values()].sort((a, b) => a.label.localeCompare(b.label, 'fr'));
  }, [rows]);

  const filtersActive = query.trim() !== '' || colorIds.length > 0 || categoryIds.length > 0;
  const clearFilters = useCallback(() => {
    setQuery('');
    setColorIds([]);
    setCategoryIds([]);
  }, []);

  // Always the fresh row; the sheet hides itself when the row disappears (every action path clears actionKey).
  const actionRow = actionKey ? rows.find((r) => rowKey(r) === actionKey) ?? null : null;

  const openPart = useCallback((r: InventoryRow) => router.push(routes.part(r.partId, r.colorId)), []);
  const openActions = useCallback((r: InventoryRow) => setActionKey(rowKey(r)), []);

  const onStepper = (r: InventoryRow, v: number) => {
    if (v === 0) {
      setActionKey(null);
      void removeWithUndo(refOf(r), rowName(r));
    } else {
      void changeQuantity(refOf(r), v);
    }
  };
  const onRemove = (r: InventoryRow) => {
    setActionKey(null);
    void removeWithUndo(refOf(r), rowName(r));
  };
  const onMove = (r: InventoryRow) => {
    setActionKey(null);
    setTimeout(() => setMoveRow(r), SHEET_SWAP_MS);
  };
  const onMoveTo = (toListId: string) => {
    const r = moveRow;
    setMoveRow(null);
    if (!r) return;
    const target = lists.data?.find((l) => l.id === toListId)?.name ?? '';
    void moveWithUndo(refOf(r), toListId, rowName(r), target);
  };

  const showGuest = session.user === null && !guestDismissed;
  const guestBanner = showGuest ? (
    <Banner
      tone="warn"
      text={t.empty.guest}
      actionLabel={session.configured ? t.empty.createAccount : undefined}
      onAction={session.configured ? () => router.push(routes.signup) : undefined}
      onDismiss={() => setGuestDismissed(true)}
    />
  ) : null;

  const listChips = (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={s.chipRow}
      accessibilityLabel={t.screen.listsA11y}
    >
      <Chip label={t.screen.allLists} selected={listId === null} onPress={() => router.setParams({ listId: '' })} />
      {(lists.data ?? []).map((l) => (
        <Chip key={l.id} label={l.name} selected={listId === l.id} onPress={() => router.setParams({ listId: l.id })} />
      ))}
    </ScrollView>
  );

  const header = (
    <View style={s.header}>
      {listChips}
      {guestBanner}
      {rows.length > 0 ? (
        <>
          <TextField
            label={t.screen.searchLabel}
            placeholder={t.screen.searchPlaceholder}
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
          <View style={s.filterRow}>
            <Chip
              icon="color-palette-outline"
              label={colorIds.length ? tpl(t.screen.filterCount, { label: t.screen.colorFilter, n: colorIds.length }) : t.screen.colorFilter}
              selected={colorIds.length > 0}
              onPress={() => setFilterMode('color')}
            />
            <Chip
              icon="pricetags-outline"
              label={categoryIds.length ? tpl(t.screen.filterCount, { label: t.screen.categoryFilter, n: categoryIds.length }) : t.screen.categoryFilter}
              selected={categoryIds.length > 0}
              onPress={() => setFilterMode('category')}
            />
          </View>
          <SegmentedControl<InventoryGroupBy>
            accessibilityLabel={t.screen.groupByA11y}
            value={groupBy}
            onChange={setGroupBy}
            options={[
              { value: 'none', label: t.screen.groupBy.none },
              { value: 'category', label: t.screen.groupBy.category },
              { value: 'color', label: t.screen.groupBy.color },
              { value: 'list', label: t.screen.groupBy.list },
            ]}
          />
        </>
      ) : null}
    </View>
  );

  const right = (
    <View style={s.headerButtons}>
      <IconButton
        icon={grid ? 'list-outline' : 'grid-outline'}
        label={grid ? t.screen.showList : t.screen.showGrid}
        onPress={() => setSetting('inventoryView', grid ? 'list' : 'grid')}
      />
      <IconButton icon="share-outline" label={t.screen.export} onPress={() => router.push(routes.exportSheet(listId))} />
    </View>
  );

  const footer = rows.length > 0 ? (
    <Text style={s.footer} accessibilityRole="summary">
      {tpl(t.screen.totals, {
        refs: tpl(plural(totals.refs, t.screen.refsOne, t.screen.refsOther), { n: fmtCount(totals.refs) }),
        pieces: tpl(plural(totals.pieces, t.screen.piecesOne, t.screen.piecesOther), { n: fmtCount(totals.pieces) }),
      })}
    </Text>
  ) : undefined;

  let body: ReactElement;
  if (inv.data === undefined && inv.error) {
    body = <ErrorState error={inv.error} onRetry={inv.reload} />;
  } else if (inv.data === undefined) {
    body = (
      <View style={s.skeletons} accessibilityLabel={t.screen.loading} accessibilityState={{ busy: true }}>
        {Array.from({ length: columns * 2 }, (_, i) => (
          <Skeleton key={i} width={tileWidth} height={tileWidth} />
        ))}
      </View>
    );
  } else {
    const empty = rows.length === 0 ? (
      <EmptyState
        icon="cube-outline"
        title={listId ? t.empty.listTitle : t.empty.title}
        message={t.empty.message}
        actionLabel={t.empty.openScanner}
        onAction={() => router.navigate(routes.scanner)}
      />
    ) : (
      <EmptyState
        icon="search-outline"
        title={t.empty.noResult}
        message={t.empty.noResultMessage}
        actionLabel={filtersActive ? t.empty.clearFilters : undefined}
        onAction={filtersActive ? clearFilters : undefined}
      />
    );
    body = (
      <SectionList<Entry, Section>
        sections={listSections}
        keyExtractor={(e) => e.key}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        stickySectionHeadersEnabled={false}
        contentContainerStyle={s.content}
        renderSectionHeader={({ section }) =>
          groupBy === 'none' ? null : (
            <Text style={s.sectionTitle} accessibilityRole="header">
              {section.title}
            </Text>
          )
        }
        renderItem={({ item }) =>
          item.kind === 'grid' ? (
            <View style={s.gridRow}>
              {item.rows.map((r) => (
                <InventoryTile key={rowKey(r)} row={r} width={tileWidth} onOpen={openPart} onActions={openActions} />
              ))}
            </View>
          ) : (
            <InventoryListItem row={item.row} showList={listId === null} onOpen={openPart} onActions={openActions} />
          )
        }
      />
    );
  }

  return (
    <Screen title={t.screen.title} right={right} footer={footer}>
      {body}
      <FilterSheet
        mode={filterMode}
        onClose={() => setFilterMode(null)}
        colorOptions={colorOptions}
        categoryOptions={categoryOptions}
        colorIds={colorIds}
        categoryIds={categoryIds}
        onToggleColor={(id) => setColorIds((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]))}
        onToggleCategory={(id) => setCategoryIds((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]))}
        onClear={() => (filterMode === 'color' ? setColorIds([]) : setCategoryIds([]))}
      />
      <BottomSheet
        visible={actionRow !== null}
        onClose={() => setActionKey(null)}
        title={actionRow ? `${rowName(actionRow)} · ${rowColorName(actionRow)}` : undefined}
      >
        {actionRow ? (
          <View style={s.sheet}>
            <Text style={s.sheetLabel}>{t.actions.quantity}</Text>
            <QuantityStepper
              value={actionRow.quantity}
              onChange={(v) => onStepper(actionRow, v)}
              label={`${rowName(actionRow)} ${rowColorName(actionRow)}`}
            />
            <Button
              label={t.actions.openPart}
              icon="information-circle-outline"
              variant="secondary"
              onPress={() => {
                setActionKey(null);
                openPart(actionRow);
              }}
            />
            <Button label={t.actions.move} icon="swap-horizontal-outline" variant="secondary" onPress={() => onMove(actionRow)} />
            <Button label={t.actions.remove} icon="trash-outline" variant="danger" onPress={() => onRemove(actionRow)} />
          </View>
        ) : null}
      </BottomSheet>
      <ListPickerSheet
        visible={moveRow !== null}
        onClose={() => setMoveRow(null)}
        lists={(lists.data ?? []).filter((l) => l.id !== moveRow?.listId)}
        selectedId={null}
        onSelect={onMoveTo}
        onCreate={createList}
      />
    </Screen>
  );
}

const s = StyleSheet.create({
  content: { paddingBottom: spacing.xl, flexGrow: 1 }, // horizontal padding comes from <Screen> (PAD)
  header: { gap: spacing.md, paddingBottom: spacing.md },
  headerButtons: { flexDirection: 'row' },
  chipRow: { gap: spacing.sm, paddingVertical: spacing.xs },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  gridRow: { flexDirection: 'row', gap: GAP },
  sectionTitle: { color: colors.text, fontSize: font.h2, fontWeight: '700', marginTop: spacing.md, marginBottom: spacing.sm },
  skeletons: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP, paddingVertical: PAD },
  footer: { color: colors.text, fontSize: font.body, textAlign: 'center', paddingVertical: spacing.sm },
  sheet: { gap: spacing.md },
  sheetLabel: { color: colors.muted, fontSize: font.small },
});
