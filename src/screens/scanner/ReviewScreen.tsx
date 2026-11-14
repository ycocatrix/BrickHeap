// Review of a pile (B3, EX_06 / EX_07, RG_03–RG_10). State = scanStore.review; lines re-derived by reviewLines.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { AccessibilityInfo, Animated, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Image } from 'expo-image';
import type { Candidate, CatalogColor, ColorId, IdentifiedPiece, ListId, Palette, ReviewLine, ReviewState } from '@/domain/types';
import { toAppError } from '@/domain/result';
import { lineCandidates } from '@/domain/pile/grouping';
import {
  confirmAllColors, confirmPartial, removeLine, restoreLine, reviewLines, reviewSummary, setLineColor, setLineQuantity,
} from '@/domain/pile/review';
import { Banner } from '@/components/Banner';
import { Button, IconButton } from '@/components/Button';
import { ColorDot } from '@/components/ColorDot';
import { ColorPickerSheet } from '@/components/ColorPickerSheet';
import { ConfidenceBadge } from '@/components/ConfidenceBadge';
import { Icon } from '@/components/Icon';
import { ListPickerSheet } from '@/components/ListPickerSheet';
import { PartImage } from '@/components/PartImage';
import { QuantityStepper } from '@/components/QuantityStepper';
import { Screen } from '@/components/Screen';
import { showSnackbar, UNDO_MS } from '@/components/Snackbar';
import { EmptyState } from '@/components/StateViews';
import { createList, getLastListId } from '@/data/inventoryRepo';
import { usePalette } from '@/hooks/useCatalog';
import { useLists } from '@/hooks/useInventory';
import { feedback } from '@/services/feedback';
import { routes } from '@/navigation/routes';
import { scanActions, scanStore } from '@/state/scanStore';
import { useStore } from '@/state/createStore';
import { common } from '@/i18n/fr/common';
import { plural, tpl } from '@/i18n/format';
import { scanner } from '@/i18n/fr/scanner';
import { colors, font, radius, spacing, touch } from '@/theme';
import { CandidateChooser } from './CandidateChooser';
import { colorInfo, statusText } from './display';
import { rgbToHex } from './scannerLogic';
import { useReduceMotion } from './useReduceMotion';

const t = scanner.review;
const CONFIRM_ALL_FROM = 3;

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // feedback / announcements never break the screen
  }
}

function announce(text: string): void {
  safe(() => AccessibilityInfo.announceForAccessibility(text));
}

function update(fn: (s: ReviewState) => ReviewState): void {
  safe(() => scanActions.updateReview(fn));
}

export default function ReviewScreen(): ReactElement {
  const router = useRouter();
  const reduceMotion = useReduceMotion();
  const storeReview = useStore(scanStore, (s) => s.review);
  const sessionAdded = useStore(scanStore, (s) => s.sessionAdded);
  const palette = usePalette();
  const lists = useLists();

  // While committing, the store clears the review: keep showing a snapshot until we leave.
  const [snapshot, setSnapshot] = useState<ReviewState | null>(null);
  const review = storeReview ?? snapshot;
  const leaving = useRef(false);

  const [listId, setListId] = useState<ListId | null>(null);
  const [listSheet, setListSheet] = useState(false);
  const [colorKey, setColorKey] = useState<string | null>(null);
  const [chooserKey, setChooserKey] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [check] = useState(() => new Animated.Value(0));
  const [retrying, setRetrying] = useState(false);

  // Restored route / fast refresh without a scan → back to the scanner.
  useEffect(() => {
    if (storeReview === null && !leaving.current) router.replace(routes.scanner);
  }, [storeReview, router]);

  useEffect(() => {
    let alive = true;
    getLastListId()
      .then((id) => {
        if (alive) setListId((cur) => cur ?? id);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const lines = useMemo(() => {
    if (!review) return [];
    try {
      return reviewLines(review, sessionAdded);
    } catch {
      return [];
    }
  }, [review, sessionAdded]);
  const summary = useMemo(() => {
    if (!review) return null;
    try {
      return reviewSummary(review);
    } catch {
      return null;
    }
  }, [review]);
  const pieceById = useMemo(() => new Map((review?.pieces ?? []).map((p) => [p.detection.id, p])), [review]);
  const pickerColors = useMemo<CatalogColor[]>(() => (palette ? [...palette.colors] : []), [palette]);

  const listName = lists.data?.find((l) => l.id === listId)?.name ?? t.noList;
  const alreadyAddedRefs = lines.filter((l) => l.alreadyAdded > 0).length;
  const toConfirmLines = lines.filter((l) => l.kind === 'color_to_confirm' && l.colorId !== null).length;

  const goBack = useCallback(() => {
    leaving.current = true;
    if (router.canGoBack()) router.back();
    else router.replace(routes.scanner);
  }, [router]);

  const resumeScan = useCallback(() => {
    goBack();
    safe(() => scanActions.resume());
  }, [goBack]);

  /** EX_09 from the review: scanActions.retryUnavailable() refreshes scanStore.pieces only (the review is never
   *  touched by the store, §4.5), so the re-identified pieces are copied into the review here. Only pieces that
   *  were 'unavailable' are replaced; every other line and the user's edits stay as they are. */
  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await scanActions.retryUnavailable();
    } catch {
      // the pieces simply stay unavailable
    }
    const fresh = new Map(scanStore.get().pieces.map((x) => [x.detection.id, x]));
    update((st) => ({
      ...st,
      pieces: st.pieces.map((x) => {
        if (x.identification.status !== 'unavailable') return x;
        const f = fresh.get(x.detection.id);
        return f && f.identification.status !== 'unavailable' && f.identification.status !== 'pending' ? f : x;
      }),
    }));
    setRetrying(false);
  };

  const closeSheets = () => {
    setListSheet(false);
    setColorKey(null);
    setChooserKey(null);
  };

  const add = async () => {
    if (!listId || !summary?.canAdd || committing) return;
    closeSheets(); // Snackbar rule (§3): no sheet open when the snackbar shows
    setCommitting(true);
    setError(null);
    setSnapshot(review);
    leaving.current = true;
    const name = listName;
    let r: Awaited<ReturnType<typeof scanActions.commitReview>>;
    try {
      r = await scanActions.commitReview(listId);
    } catch (e) {
      r = { ok: false, error: toAppError(e) };
    }
    if (!r.ok) {
      leaving.current = false;
      setSnapshot(null);
      setCommitting(false);
      safe(() => feedback.error());
      setError(r.error.message);
      announce(r.error.message);
      return;
    }
    const { added, skipped, undo } = r.value;
    safe(() => feedback.success());
    const text =
      skipped > 0
        ? tpl(t.addedSkipped, { n: added, k: skipped })
        : tpl(plural(added, t.addedOne, t.added), { n: added, list: name });
    announce(text);
    setDone(true);
    if (!reduceMotion) {
      check.setValue(0.6);
      Animated.spring(check, { toValue: 1, useNativeDriver: true, speed: 20, bounciness: 8 }).start();
    } else {
      check.setValue(1);
    }
    setTimeout(
      () => {
        if (router.canGoBack()) router.back();
        else router.replace(routes.scanner);
        safe(() =>
          showSnackbar({
            text,
            actionLabel: common.actions.undo,
            durationMs: UNDO_MS,
            onAction: async () => {
              try {
                await undo();
                safe(() => feedback.success());
                announce(t.undone);
              } catch {
                safe(() => feedback.error());
              }
            },
          }),
        );
      },
      reduceMotion ? 300 : 650,
    );
  };

  // ---------- sheets data ----------
  const colorLine = colorKey ? lines.find((l) => l.key === colorKey) ?? null : null;
  const colorFirst = colorLine ? pieceById.get(colorLine.detectionIds[0]) : undefined;
  const chooserLine = chooserKey ? lines.find((l) => l.key === chooserKey) ?? null : null;
  const chooserCandidates = useMemo<Candidate[]>(() => {
    if (!chooserLine || !review) return [];
    try {
      return lineCandidates(review.pieces, chooserLine.detectionIds);
    } catch {
      return [];
    }
  }, [chooserLine, review]);
  const chooserMembers = chooserLine ? chooserLine.detectionIds.map((id) => pieceById.get(id)).filter((p): p is IdentifiedPiece => !!p) : [];

  // ---------- render ----------
  if (!review) {
    return <Screen title={t.title}>{null}</Screen>;
  }

  if (done) {
    return (
      <Screen title={t.title}>
        <View style={s.done} accessibilityLiveRegion="polite">
          <Animated.View style={{ transform: [{ scale: check }], opacity: check }}>
            <Icon name="checkmark-circle" size={96} color={colors.ok} />
          </Animated.View>
          <Text style={s.doneText}>{t.success}</Text>
        </View>
      </Screen>
    );
  }

  const removedCount = review.removed.length;
  const restoreAll = () => update((st) => st.removed.reduce((acc, k) => restoreLine(acc, k), st));

  if (lines.length === 0) {
    return (
      <Screen title={t.title} onBack={goBack}>
        <View style={s.emptyWrap}>
          <EmptyState icon="cube-outline" title={t.empty} message={t.emptyMessage} actionLabel={t.resumeScan} onAction={resumeScan} />
          {removedCount > 0 ? <Button label={t.restoreAll} variant="ghost" onPress={restoreAll} /> : null}
        </View>
      </Screen>
    );
  }

  const ignored = summary ? summary.unknown + summary.partial : 0;
  const pieces = summary?.pieces ?? 0;
  const disabledReason = !summary
    ? null
    : summary.colorToConfirm > 0
      ? tpl(t.reasonColor, { n: summary.colorToConfirm })
      : summary.pieces === 0
        ? t.reasonEmpty
        : null;

  const footer = (
    <View style={s.footer}>
      <Pressable
        onPress={() => setListSheet(true)}
        style={s.listSel}
        accessibilityRole="button"
        accessibilityLabel={tpl(t.listA11y, { name: listName })}
      >
        <Icon name="list-outline" size={18} color={colors.muted} />
        <Text style={s.listText} numberOfLines={1}>
          {tpl(t.list, { name: listName })}
        </Text>
        <Icon name="chevron-down" size={18} color={colors.text} />
      </Pressable>
      {error ? <Banner tone="error" text={error} /> : null}
      <Button
        label={tpl(plural(pieces, t.addOne, t.add), { n: pieces, list: listName })}
        icon="add"
        onPress={() => void add()}
        loading={committing}
        disabled={!summary?.canAdd || !listId}
        accessibilityHint={disabledReason ?? undefined}
      />
      {summary && summary.toVerify > 0 ? <Text style={s.sub}>{tpl(t.toVerify, { n: summary.toVerify })}</Text> : null}
      {ignored > 0 ? <Text style={s.sub}>{tpl(t.ignored, { n: ignored })}</Text> : null}
      {disabledReason ? (
        <View style={s.reason} accessibilityLiveRegion="polite">
          <Icon name="alert-circle-outline" size={16} color={colors.warn} />
          <Text style={s.reasonText}>{disabledReason}</Text>
        </View>
      ) : null}
    </View>
  );

  const header = (
    <View style={s.headerBlock}>
      <Banner tone="warn" text={t.approx} />
      {alreadyAddedRefs > 0 ? <Banner tone="info" text={tpl(t.alreadyAdded, { n: alreadyAddedRefs })} /> : null}
      {toConfirmLines >= CONFIRM_ALL_FROM ? (
        <Button label={t.confirmAll} variant="secondary" icon="checkmark-done" onPress={() => update(confirmAllColors)} />
      ) : null}
    </View>
  );

  return (
    <Screen title={t.title} onBack={goBack} footer={footer}>
      <FlatList
        data={lines}
        keyExtractor={(l) => l.key}
        ListHeaderComponent={header}
        ListFooterComponent={
          removedCount > 0 ? (
            <View style={s.removed}>
              <Text style={s.sub}>{tpl(t.removedLines, { n: removedCount })}</Text>
              <Button label={t.restoreAll} variant="ghost" onPress={restoreAll} />
            </View>
          ) : undefined
        }
        contentContainerStyle={s.listContent}
        renderItem={({ item }) => (
          <ReviewRow
            line={item}
            first={pieceById.get(item.detectionIds[0])}
            members={item.detectionIds.map((id) => pieceById.get(id))}
            palette={palette}
            onOpen={() => {
              if (item.partId) router.push(routes.part(item.partId, item.colorId));
            }}
            onColor={() => setColorKey(item.key)}
            onChoose={() => setChooserKey(item.key)}
            retrying={retrying}
            onRetry={() => void retry()}
          />
        )}
      />

      <ListPickerSheet
        visible={listSheet}
        onClose={() => setListSheet(false)}
        lists={lists.data ?? []}
        selectedId={listId}
        onSelect={(id) => {
          setListId(id);
          setListSheet(false);
        }}
        onCreate={async (name) => {
          const r = await createList(name);
          if (r.ok) {
            setListId(r.value.id);
            lists.reload();
            setListSheet(false);
          }
          return r;
        }}
      />

      <ColorPickerSheet
        visible={!!colorLine}
        onClose={() => setColorKey(null)}
        colors={pickerColors}
        suggested={colorFirst?.color.alternatives ?? []}
        selected={colorLine?.colorId ?? null}
        referenceUri={colorLine?.cropUri ?? null}
        measuredHex={rgbToHex(colorFirst?.detection.rgb ?? null)}
        onSelect={(colorId: ColorId) => {
          const key = colorKey;
          setColorKey(null);
          if (key) update((st) => setLineColor(st, key, colorId));
        }}
      />

      {chooserLine ? (
        <CandidateChooser
          visible
          onClose={() => setChooserKey(null)}
          cropUri={chooserLine.cropUri}
          candidates={chooserCandidates}
          pending={chooserMembers.length > 0 && chooserMembers.every((m) => m.identification.status === 'pending')}
          unavailable={chooserMembers.length > 0 && chooserMembers.every((m) => m.identification.status === 'unavailable')}
          onChoose={(c) => {
            const key = chooserLine.key;
            setChooserKey(null);
            Promise.resolve()
              .then(() => scanActions.chooseCandidate({ groupKey: key }, c))
              .catch(() => safe(() => feedback.error()));
          }}
        />
      ) : null}
    </Screen>
  );
}

function ReviewRow(p: {
  line: ReviewLine;
  first: IdentifiedPiece | undefined;
  members: (IdentifiedPiece | undefined)[];
  palette: Palette | null;
  onOpen: () => void;
  onColor: () => void;
  onChoose: () => void;
  retrying: boolean;
  onRetry: () => void;
}): ReactElement {
  const l = p.line;
  const color = colorInfo(p.palette, l.colorId);
  const name = l.name || scanner.box.unknownName;
  const colorSuffix = color.label !== '—' ? ` ${color.label}` : '';
  const title = tpl(t.lineTitle, { qty: l.quantity, name: name + colorSuffix });
  const useCrop = l.kind !== 'ok' && !!l.cropUri;
  const countable = l.kind === 'ok' || l.kind === 'color_to_confirm';
  const colorEditable = l.kind !== 'unknown';
  const unavailable = l.kind === 'unknown' && p.members.some((m) => m?.identification.status === 'unavailable');
  const subject = name + colorSuffix;

  return (
    <View style={[s.row, l.kind === 'color_to_confirm' && s.rowWarn]}>
      <View style={s.rowTop}>
        <Pressable
          onPress={p.onOpen}
          disabled={!l.partId}
          style={s.rowMain}
          accessibilityRole={l.partId ? 'button' : 'text'}
          accessibilityLabel={l.partId ? tpl(t.openPart, { name: title }) : title}
        >
          {useCrop ? (
            <Image source={{ uri: l.cropUri ?? undefined }} style={s.thumb} contentFit="cover" accessible={false} />
          ) : (
            <PartImage uri={l.imageUrl} size={56} />
          )}
          <View style={s.rowText}>
            <Text style={s.title}>{title}</Text>
            {l.provisional && l.partId ? <Text style={s.muted}>{l.partId}</Text> : null}
          </View>
        </Pressable>
        {colorEditable ? (
          <Pressable
            onPress={p.onColor}
            style={s.dotBtn}
            accessibilityRole="button"
            accessibilityLabel={tpl(t.changeColorA11y, { color: color.label })}
          >
            <ColorDot hex={color.hex} isTrans={color.isTrans} size={24} />
          </Pressable>
        ) : null}
        {l.level === 'review' && l.kind !== 'unknown' ? (
          <Pressable
            onPress={p.onChoose}
            style={s.badgeBtn}
            accessibilityRole="button"
            accessibilityLabel={`${statusText('review')}, ${subject}`}
            accessibilityHint={t.badgeHint}
          >
            <ConfidenceBadge level={l.level} confidence={l.confidence} compact />
          </Pressable>
        ) : (
          <View style={s.badgeBtn}>
            <ConfidenceBadge level={l.level} confidence={l.confidence} compact />
          </View>
        )}
      </View>

      {l.kind === 'color_to_confirm' ? (
        <View style={s.actions}>
          <View style={s.statusRow}>
            <Icon name="color-palette-outline" size={16} color={colors.warn} />
            <Text style={s.warnText}>{t.colorToConfirm}</Text>
          </View>
          <View style={s.btnRow}>
            {l.colorId !== null ? (
              <Button
                label={tpl(t.confirmColor, { color: color.label })}
                onPress={() => {
                  const c = l.colorId;
                  if (c !== null) update((st) => setLineColor(st, l.key, c));
                }}
                style={s.flex}
              />
            ) : null}
            <Button label={t.changeColor} variant="secondary" onPress={p.onColor} style={s.flex} />
          </View>
        </View>
      ) : null}

      {l.kind === 'partial' ? (
        <View style={s.actions}>
          <View style={s.statusRow}>
            <Icon name="cut-outline" size={16} color={colors.muted} />
            <Text style={s.mutedStrong}>{t.partial}</Text>
          </View>
          <Button label={t.countPartial} variant="secondary" onPress={() => update((st) => confirmPartial(st, l.key))} />
        </View>
      ) : null}

      {l.kind === 'unknown' ? (
        <View style={s.actions}>
          <View style={s.statusRow}>
            <Icon name={unavailable ? 'cloud-offline-outline' : 'help-circle-outline'} size={16} color={colors.muted} />
            <Text style={s.mutedStrong}>{unavailable ? t.unavailable : t.unknown}</Text>
          </View>
          {unavailable ? (
            <Button label={common.actions.retry} variant="secondary" icon="refresh" onPress={p.onRetry} loading={p.retrying} />
          ) : (
            <Button label={t.choose} variant="secondary" onPress={p.onChoose} />
          )}
        </View>
      ) : null}

      <View style={s.bottomRow}>
        {countable ? (
          <QuantityStepper
            value={l.quantity}
            onChange={(v) => update((st) => setLineQuantity(st, l.key, v))}
            min={0}
            max={9999}
            label={subject}
          />
        ) : (
          <View />
        )}
        <IconButton icon="trash-outline" label={tpl(t.remove, { name: subject })} onPress={() => update((st) => removeLine(st, l.key))} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  listContent: { paddingBottom: spacing.lg, gap: spacing.sm },
  headerBlock: { gap: spacing.sm, marginBottom: spacing.sm },
  row: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, gap: spacing.sm },
  rowWarn: { borderWidth: 1, borderColor: colors.warn },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: touch.min },
  thumb: { width: 56, height: 56, borderRadius: radius.sm, backgroundColor: colors.tileBg },
  rowText: { flex: 1 },
  title: { color: colors.text, fontSize: font.body, fontWeight: '600' },
  muted: { color: colors.muted, fontSize: font.small },
  mutedStrong: { color: colors.muted, fontSize: font.small, fontWeight: '700' },
  warnText: { color: colors.warn, fontSize: font.small, fontWeight: '700' },
  dotBtn: { minWidth: touch.min, minHeight: touch.min, alignItems: 'center', justifyContent: 'center' },
  badgeBtn: { minWidth: touch.min, minHeight: touch.min, alignItems: 'center', justifyContent: 'center' },
  actions: { gap: spacing.sm },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  btnRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  flex: { flexGrow: 1 },
  bottomRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  removed: { alignItems: 'center', gap: spacing.xs, marginTop: spacing.md },
  footer: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.sm, backgroundColor: colors.surface },
  listSel: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: touch.min },
  listText: { flex: 1, color: colors.text, fontSize: font.body },
  sub: { color: colors.muted, fontSize: font.small, textAlign: 'center' },
  reason: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs },
  reasonText: { color: colors.warn, fontSize: font.small, flexShrink: 1 },
  emptyWrap: { flex: 1, justifyContent: 'center', gap: spacing.md },
  done: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  doneText: { color: colors.text, fontSize: font.h2, fontWeight: '700' },
});
