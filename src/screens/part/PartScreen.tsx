// Fiche pièce (C1, EX_12, EX_13, EX_14, RT_01). Route: /part/:partId?colorId ('' = unknown colour).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type { AppError, ColorId, ListId, SetRef } from '@/domain/types';
import { categoryLabel, designId, filterSets, parseDimensions, partLabel, pickABrickUrl, setYears } from '@/domain/catalog/partInfo';
import { useAsync } from '@/hooks/useAsync';
import { usePalette, usePart, usePartDetail } from '@/hooks/useCatalog';
import { useLists } from '@/hooks/useInventory';
import { getLocalPartColor, getPartDetail, getSetQuantity, hydrateParts } from '@/services/catalog';
import { applyDeltas, createList } from '@/data/inventoryRepo';
import { useDbVersion } from '@/data/dbEvents';
import { feedback } from '@/services/feedback';
import { Screen } from '@/components/Screen';
import { Button } from '@/components/Button';
import { Banner } from '@/components/Banner';
import { ColorDot } from '@/components/ColorDot';
import { PartImage } from '@/components/PartImage';
import { Chip } from '@/components/Chip';
import { ListRow } from '@/components/ListRow';
import { TextField } from '@/components/TextField';
import { EmptyState, ErrorState, LoadingState, Skeleton } from '@/components/StateViews';
import { ColorPickerSheet } from '@/components/ColorPickerSheet';
import { ListPickerSheet } from '@/components/ListPickerSheet';
import { showSnackbar, UNDO_MS } from '@/components/Snackbar';
import { routes } from '@/navigation/routes';
import { colors, font, radius, spacing, touch } from '@/theme';
import { colorLabel } from '@/i18n/fr/colors';
import { common } from '@/i18n/fr/common';
import { part as t } from '@/i18n/fr/part';
import { fmtCount, tpl } from '@/i18n/format';

const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));
const parseColorId = (v: string): ColorId | null => (v.trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v));

type Qty = { state: 'loading' } | { state: 'done'; value: number | null } | { state: 'error' };

interface SetsState { key: string; sets: SetRef[]; total: number; lastPage: number }

export default function PartScreen(): ReactElement {
  const params = useLocalSearchParams<{ partId: string; colorId?: string }>();
  const partId = one(params.partId);
  const [colorId, setColorId] = useState<ColorId | null>(() => parseColorId(one(params.colorId)));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [listsOpen, setListsOpen] = useState(false);

  const palette = usePalette();
  const partState = usePart(partId || null);
  const part = partState.data ?? null;
  const color = colorId !== null ? (palette?.byId.get(colorId) ?? null) : null;
  const provisional = part?.source === 'brickognize';

  // A part never cached locally (e.g. an inventory row not hydrated yet): ask the catalogue once.
  const askedHydrate = useRef(false);
  useEffect(() => {
    if (partId && !partState.loading && part === null && !askedHydrate.current) {
      askedHydrate.current = true;
      void hydrateParts([partId]);
    }
  }, [partId, partState.loading, part]);

  const catalogVersion = useDbVersion('catalog');
  const local = useAsync(
    () => (partId && colorId !== null ? getLocalPartColor(partId, colorId) : Promise.resolve(null)),
    [partId, colorId, catalogVersion],
  );
  const detail = usePartDetail(partId && !provisional ? partId : null, colorId);
  // useAsync keeps the previous data while reloading or after an error: only use it for the current part+colour.
  const detailData = detail.data && detail.data.partColor.partId === partId && detail.data.partColor.colorId === colorId
    ? detail.data : null;
  const partColor = detailData?.partColor ?? local.data ?? null;
  const imageUri = (partColor?.found ? partColor.imageUrl : null) ?? part?.imageUrl ?? null;
  const coloredImage = !!(partColor?.found && partColor.imageUrl);

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace(routes.scanner);
  }, []);

  // ---------------------------------------------------------------- sets (EX_14)
  // Every piece of sets state is keyed by part+colour, so a colour change starts from a clean slate without effects.
  const detailKey = `${partId}|${colorId ?? ''}`;
  const [extra, setExtra] = useState<SetsState | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreErr, setMoreErr] = useState<{ key: string; error: AppError } | null>(null);
  const [filter, setFilter] = useState<{ key: string; query: string; year: number | null }>({ key: '', query: '', year: null });
  const [qtyState, setQtyState] = useState<{ key: string; map: Record<string, Qty> }>({ key: '', map: {} });

  const firstPage = detailData?.sets ?? null;
  const current = useMemo<SetsState | null>(() => {
    if (!firstPage) return null;
    const more = extra && extra.key === detailKey ? extra : null;
    if (!more) return { key: detailKey, sets: firstPage.sets, total: firstPage.total, lastPage: firstPage.page };
    const known = new Set(firstPage.sets.map((x) => x.setNum));
    return {
      key: detailKey,
      sets: [...firstPage.sets, ...more.sets.filter((x) => !known.has(x.setNum))],
      total: more.total,
      lastPage: more.lastPage,
    };
  }, [firstPage, extra, detailKey]);
  const hasMore = !!current && current.sets.length < current.total && current.lastPage < 50;
  const moreError = moreErr && moreErr.key === detailKey ? moreErr.error : null;
  const query = filter.key === detailKey ? filter.query : '';
  const year = filter.key === detailKey ? filter.year : null;
  const qty = useMemo<Record<string, Qty>>(() => (qtyState.key === detailKey ? qtyState.map : {}), [qtyState, detailKey]);
  const setQuery = (q: string) => setFilter({ key: detailKey, query: q, year });
  const setYear = (y: number | null) => setFilter({ key: detailKey, query, year: y });

  const loadMore = useCallback(async () => {
    if (!current || loadingMore || colorId === null) return;
    const key = current.key;
    const base = current;
    setLoadingMore(true);
    setMoreErr(null);
    const r = await getPartDetail(partId, colorId, base.lastPage + 1);
    setLoadingMore(false);
    if (!r.ok) {
      setMoreErr({ key, error: r.error });
      return;
    }
    const page = r.value.sets;
    if (!page) return;
    setExtra((prev) => {
      const prevSets = prev && prev.key === key ? prev.sets : [];
      return { key, sets: [...prevSets, ...page.sets], total: page.total, lastPage: page.page };
    });
  }, [current, loadingMore, partId, colorId]);

  const filtered = useMemo(() => (current ? filterSets(current.sets, { query, year }) : []), [current, query, year]);
  const years = useMemo(() => (current ? setYears(current.sets) : []), [current]);
  const filterActive = query.trim() !== '' || year !== null;

  // When a filter change leaves the list empty and pages remain, load the next page once (one call per change).
  const autoLoadedFor = useRef<string | null>(null);
  useEffect(() => {
    const filterKey = `${detailKey}|${query.trim()}|${year ?? ''}`;
    if (!filterActive || filtered.length > 0 || !hasMore || loadingMore) return;
    if (autoLoadedFor.current === filterKey) return;
    autoLoadedFor.current = filterKey;
    void loadMore();
  }, [filterActive, filtered.length, hasMore, loadingMore, loadMore, detailKey, query, year]);

  const loadQty = useCallback(async (setNum: string) => {
    if (colorId === null) return;
    const existing = qty[setNum];
    if (existing && existing.state !== 'error') return;
    const key = detailKey;
    const put = (v: Qty) =>
      setQtyState((st) => ({ key, map: { ...(st.key === key ? st.map : {}), [setNum]: v } }));
    put({ state: 'loading' });
    const r = await getSetQuantity(setNum, partId, colorId);
    put(r.ok ? { state: 'done', value: r.value } : { state: 'error' });
  }, [qty, partId, colorId, detailKey]);

  // ---------------------------------------------------------------- add to a list
  const lists = useLists();
  const addToList = useCallback(async (listId: ListId) => {
    setListsOpen(false); // Snackbar rule (§3): close the sheet before any snackbar
    if (colorId === null) return;
    const listName = lists.data?.find((l) => l.id === listId)?.name;
    try {
      const applied = await applyDeltas([{ listId, partId, colorId, delta: 1 }]);
      feedback.success();
      showSnackbar({
        text: listName ? tpl(t.added, { list: listName }) : t.addedShort,
        actionLabel: common.actions.undo,
        durationMs: UNDO_MS,
        onAction: async () => {
          try {
            await applyDeltas(applied.inverse);
            feedback.success();
          } catch {
            feedback.error();
          }
        },
      });
    } catch {
      feedback.error();
      showSnackbar({ text: t.addFailed });
    }
  }, [colorId, partId, lists.data]);

  const openLego = useCallback(async () => {
    if (!part) return;
    try {
      await Linking.openURL(pickABrickUrl(part, partColor?.found ? partColor.elementIds : undefined));
    } catch {
      showSnackbar({ text: t.buyFailed });
    }
  }, [part, partColor]);

  // ---------------------------------------------------------------- render
  if (partState.loading && !part) {
    return (
      <Screen title={t.title} onBack={goBack} scroll>
        <View style={s.headerImage}><Skeleton width={200} height={200} radius={radius.md} /></View>
        <Skeleton height={28} />
        <View style={s.gap} />
        <Skeleton height={18} width="70%" />
        <View style={s.gap} />
        <Skeleton height={120} radius={radius.md} />
      </Screen>
    );
  }

  const name = part?.name ?? partId;
  const label = partLabel(name);
  const dims = parseDimensions(name);
  const colorText = color ? tpl(t.colorLine, { color: colorLabel(color), hex: color.hex }) : t.noColor;
  const elementIds = partColor?.found && partColor.elementIds.length > 0 ? partColor.elementIds.join(', ') : t.identity.none;
  const category = part ? categoryLabel(part.categoryId, part.categoryId !== null ? (palette?.categoryName.get(part.categoryId) ?? null) : null) : null;

  return (
    <Screen title={t.title} onBack={goBack} scroll>
      <View style={s.headerImage}>
        <PartImage
          uri={imageUri}
          size={200}
          accessibilityLabel={tpl(t.imageLabel, { name: label })}
          colorCue={!coloredImage && color ? { hex: color.hex, isTrans: color.isTrans } : null}
        />
      </View>

      <Text style={s.title} accessibilityRole="header">{label}</Text>
      <Text style={s.official}>{tpl(t.officialName, { name })}</Text>

      <Pressable
        onPress={() => setPickerOpen(true)}
        disabled={!palette}
        accessibilityRole="button"
        accessibilityLabel={`${t.changeColor}, ${colorText}`}
        accessibilityHint={t.changeColorHint}
        style={({ pressed }) => [s.colorRow, pressed && s.pressed]}
      >
        <ColorDot hex={color?.hex ?? null} isTrans={color?.isTrans} size={22} />
        <Text style={s.colorText}>{colorText}</Text>
        <Text style={s.colorChange}>{t.changeColor}</Text>
      </Pressable>

      {provisional ? <View style={s.block}><Banner tone="info" text={t.provisional} /></View> : null}
      {!part && !partState.loading ? <View style={s.block}><Banner tone="info" text={t.unknownPart} /></View> : null}
      {partColor && !partColor.found ? <View style={s.block}><Banner tone="warn" text={t.notInColor} /></View> : null}
      {detailData?.stale ? <View style={s.block}><Banner tone="info" text={t.stale} /></View> : null}

      <View style={s.card}>
        <InfoRow label={t.identity.partId} value={partId} />
        <InfoRow label={t.identity.designId} value={part ? designId(part) : t.identity.none} />
        <InfoRow label={t.identity.elementId} value={elementIds} />
        <InfoRow label={t.identity.category} value={category ?? t.identity.none} />
        <InfoRow label={t.identity.dimensions} value={dims?.label ?? t.identity.none} last />
      </View>

      <View style={s.actions}>
        <Button label={t.buy} icon="open-outline" onPress={() => void openLego()} disabled={!part} accessibilityHint={t.buyHint} />
        <Text style={s.sub}>{t.buySub}</Text>
        <Button
          label={t.addToList}
          variant="secondary"
          onPress={() => setListsOpen(true)}
          disabled={colorId === null}
          accessibilityHint={colorId === null ? t.addNeedsColor : undefined}
        />
        {colorId === null ? <Text style={s.sub}>{t.addNeedsColor}</Text> : null}
      </View>

      <Text style={s.section} accessibilityRole="header">
        {current ? tpl(t.sets.titleCount, { total: fmtCount(current.total) }) : t.sets.title}
      </Text>
      {renderSets()}

      {palette ? (
        <ColorPickerSheet
          visible={pickerOpen}
          onClose={() => setPickerOpen(false)}
          colors={palette.colors}
          selected={colorId}
          onSelect={(id) => {
            setPickerOpen(false);
            setColorId(id);
          }}
        />
      ) : null}
      <ListPickerSheet
        visible={listsOpen}
        onClose={() => setListsOpen(false)}
        lists={lists.data ?? []}
        onSelect={(id) => void addToList(id)}
        onCreate={createList}
      />
    </Screen>
  );

  function renderSets(): ReactElement {
    if (colorId === null) {
      return <EmptyState icon="color-palette-outline" title={t.sets.chooseColor} actionLabel={t.sets.chooseColorAction}
        onAction={palette ? () => setPickerOpen(true) : undefined} />;
    }
    if (provisional) return <Text style={s.muted}>{t.provisionalNoSets}</Text>;
    if (partColor && !partColor.found) return <Text style={s.muted}>{t.notInColor}</Text>;
    if (detail.loading && !current) {
      return (
        <View style={s.gapList}>
          <Skeleton height={56} />
          <Skeleton height={56} />
          <Skeleton height={56} />
        </View>
      );
    }
    if (detail.error && !current) return <ErrorState error={detail.error} onRetry={detail.reload} />;
    if (!current || current.total === 0) return <Text style={s.muted}>{t.sets.empty}</Text>;

    return (
      <View>
        <TextField
          label={t.sets.searchLabel}
          placeholder={t.sets.searchPlaceholder}
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
          returnKeyType="search"
        />
        {years.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
            <Chip label={t.sets.allYears} selected={year === null} onPress={() => setYear(null)} />
            {years.map((y) => (
              <Chip key={y} label={String(y)} selected={year === y} onPress={() => setYear(year === y ? null : y)} />
            ))}
          </ScrollView>
        ) : null}
        {hasMore ? (
          <Text style={s.muted} accessibilityLiveRegion="polite">
            {tpl(t.sets.loadedOf, { loaded: fmtCount(current.sets.length), total: fmtCount(current.total) })}
          </Text>
        ) : null}

        {filtered.length === 0 && !loadingMore ? (
          <EmptyState icon="search-outline" title={t.sets.noMatch} actionLabel={t.sets.clearFilter}
            onAction={() => { setQuery(''); setYear(null); }} />
        ) : null}
        {filtered.map((set) => <SetRow key={set.setNum} set={set} qty={qty[set.setNum]} onPress={() => void loadQty(set.setNum)} />)}

        {loadingMore ? <LoadingState label={t.sets.loadingMore} /> : null}
        {moreError ? <ErrorState error={moreError} onRetry={() => void loadMore()} /> : null}
        {hasMore && !loadingMore ? (
          <View style={s.block}>
            <Button label={t.sets.loadMore} variant="secondary" onPress={() => void loadMore()} />
          </View>
        ) : null}
      </View>
    );
  }
}

function InfoRow(p: { label: string; value: string; last?: boolean }): ReactElement {
  return (
    <View style={[s.infoRow, !p.last && s.infoBorder]} accessible accessibilityLabel={`${p.label} : ${p.value}`}>
      <Text style={s.infoLabel}>{p.label}</Text>
      <Text style={s.infoValue} selectable>{p.value}</Text>
    </View>
  );
}

function SetRow(p: { set: SetRef; qty: Qty | undefined; onPress: () => void }): ReactElement {
  const { set, qty } = p;
  const qtyText = !qty ? null
    : qty.state === 'loading' ? t.sets.loadingMore
      : qty.state === 'error' ? t.sets.quantityError
        : qty.value === null ? t.sets.quantityNone : tpl(t.sets.quantity, { n: qty.value });
  const a11y = qty?.state === 'done'
    ? tpl(t.sets.rowLabelQty, { num: set.setNum, name: set.name, year: set.year, qty: qtyText ?? '' })
    : tpl(t.sets.rowLabel, { num: set.setNum, name: set.name, year: set.year });
  return (
    <ListRow
      title={set.name}
      subtitle={`${set.setNum} · ${set.year} · ${tpl(t.sets.parts, { n: fmtCount(set.numParts) })}`}
      left={<PartImage uri={set.imageUrl} size={56} />}
      right={qtyText ? <Text style={[s.qty, qty?.state === 'done' && qty.value !== null && s.qtyStrong]}>{qtyText}</Text> : null}
      onPress={p.onPress}
      accessibilityLabel={a11y}
    />
  );
}

const s = StyleSheet.create({
  headerImage: { alignItems: 'center', paddingVertical: spacing.md },
  title: { color: colors.text, fontSize: font.title, fontWeight: '700' },
  official: { color: colors.muted, fontSize: font.small, marginTop: spacing.xs },
  colorRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: touch.min, marginTop: spacing.sm,
    paddingHorizontal: spacing.sm, borderRadius: radius.md,
  },
  pressed: { backgroundColor: colors.surface },
  colorText: { color: colors.text, fontSize: font.body, flex: 1 },
  colorChange: { color: colors.primary, fontSize: font.small, fontWeight: '600' },
  block: { marginTop: spacing.md },
  card: {
    marginTop: spacing.lg, backgroundColor: colors.surface, borderRadius: radius.md, paddingHorizontal: spacing.lg,
  },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, paddingVertical: spacing.md },
  infoBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  infoLabel: { color: colors.muted, fontSize: font.body },
  infoValue: { color: colors.text, fontSize: font.body, flexShrink: 1, textAlign: 'right' },
  actions: { marginTop: spacing.lg, gap: spacing.sm },
  sub: { color: colors.muted, fontSize: font.small, textAlign: 'center' },
  section: { color: colors.text, fontSize: font.h2, fontWeight: '700', marginTop: spacing.xl, marginBottom: spacing.sm },
  muted: { color: colors.muted, fontSize: font.small, marginVertical: spacing.sm },
  chips: { gap: spacing.sm, paddingVertical: spacing.sm },
  qty: { color: colors.muted, fontSize: font.small },
  qtyStrong: { color: colors.primary, fontSize: font.body, fontWeight: '700' },
  gap: { height: spacing.sm },
  gapList: { gap: spacing.sm },
});
