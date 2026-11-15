// Scanner tab (B1, B2, B4 — EX_01/02/03/05/08/09). Camera, live loop, overlay, drawer, controls.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { AccessibilityInfo, Animated, BackHandler, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { CameraView } from 'expo-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Candidate, DetectionId, PileGroup, Point, ScanMode, Size } from '@/domain/types';
import { lineCandidates } from '@/domain/pile/grouping';
import { VISION } from '@/domain/vision/config';
import { Banner } from '@/components/Banner';
import { IconButton } from '@/components/Button';
import { ErrorState } from '@/components/StateViews';
import { usePalette } from '@/hooks/useCatalog';
import { feedback } from '@/services/feedback';
import { routes } from '@/navigation/routes';
import { scanActions, scanStore } from '@/state/scanStore';
import { useStore } from '@/state/createStore';
import { useSetting } from '@/state/settings';
import { common } from '@/i18n/fr/common';
import { tpl } from '@/i18n/format';
import { scanner } from '@/i18n/fr/scanner';
import { colors, font, radius, spacing } from '@/theme';
import { BoxOverlay } from './BoxOverlay';
import { CameraPermission } from './CameraPermission';
import { CandidateChooser } from './CandidateChooser';
import { PileDrawer } from './PileDrawer';
import { ScanControls } from './ScanControls';
import { useCamera } from './useCamera';
import { useLiveLoop } from './useLiveLoop';
import { useReduceMotion } from './useReduceMotion';
import { drawerVisible } from './scannerLogic';

type ChooserTarget = { kind: 'detection'; id: DetectionId } | { kind: 'group'; key: string; ids: DetectionId[] };

const TOAST_MS = 2000;
const NO_IDS: DetectionId[] = [];

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // UI feedback must never break the screen.
  }
}

/** Runs an async store action without letting a synchronous throw or a rejection escape. */
function fire(fn: () => Promise<unknown>): void {
  Promise.resolve()
    .then(fn)
    .catch(() => undefined);
}

export default function ScannerScreen(): ReactElement {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const cameraRef = useRef<CameraView | null>(null);
  const cam = useCamera(cameraRef);
  const palette = usePalette();
  const reduceMotion = useReduceMotion();

  const mode = useStore(scanStore, (s) => s.mode);
  const phase = useStore(scanStore, (s) => s.phase);
  const frame = useStore(scanStore, (s) => s.frame);
  const pieces = useStore(scanStore, (s) => s.pieces);
  const selectedId = useStore(scanStore, (s) => s.selectedId);
  const notice = useStore(scanStore, (s) => s.notice);
  const liveOk = useStore(scanStore, (s) => s.liveOk);
  const liveExplorer = useSetting('liveExplorer');
  const calibration = useSetting('calibration');

  const [viewSize, setViewSize] = useState<Size | null>(null);
  const [drawerSnap, setDrawerSnap] = useState(0);
  const [highlight, setHighlight] = useState<{ key: string | null; ids: DetectionId[] }>({ key: null, ids: NO_IDS });
  const [chooser, setChooser] = useState<ChooserTarget | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [flash] = useState(() => new Animated.Value(0));
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const granted = cam.permission?.granted === true;
  const mountCamera = cam.active && granted && !cam.mountError;
  const liveEnabled = mountCamera && cam.ready && liveExplorer && liveOk && phase === 'live';
  const { portraitHint } = useLiveLoop({ enabled: liveEnabled, viewSize, takePicture: cam.takePicture });
  const manualAnalyze = !liveExplorer || !liveOk;
  const liveInventory = phase === 'live' && mode === 'inventory';

  // ---------- small UI helpers ----------
  const showToast = useCallback((text: string) => {
    setToast(text);
    safe(() => AccessibilityInfo.announceForAccessibility(text));
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  const flashCue = useCallback(() => {
    if (reduceMotion) return;
    flash.setValue(0.6);
    Animated.timing(flash, { toValue: 0, duration: 200, useNativeDriver: true }).start();
  }, [flash, reduceMotion]);

  // The drawer only exists from 2 pieces (RG_01): below that it is collapsed.
  const drawerSnapEff = drawerVisible(pieces.length) ? drawerSnap : 0;

  // §7.2.6: announce the count once boxes of a capture / frozen view are known.
  const announced = useRef<string>('');
  useEffect(() => {
    if (phase !== 'frozen' || pieces.length < 2) return;
    const key = `${pieces.length}`;
    if (announced.current === key) return;
    announced.current = key;
    safe(() => AccessibilityInfo.announceForAccessibility(tpl(scanner.drawer.announce, { n: pieces.length })));
  }, [phase, pieces.length]);
  useEffect(() => {
    if (phase === 'live') announced.current = '';
  }, [phase]);

  // ---------- actions ----------
  const resume = useCallback(() => {
    safe(() => scanActions.resume());
    setHighlight({ key: null, ids: NO_IDS });
    setChooser(null);
  }, []);

  const openPartOf = useCallback(
    (id: DetectionId): boolean => {
      const piece = scanStore.get().pieces.find((x) => x.detection.id === id);
      if (!piece?.part) return false;
      router.push(routes.part(piece.part.partId, piece.color.colorId));
      return true;
    },
    [router],
  );

  const onBoxPress = useCallback(
    (id: DetectionId) => {
      const st = scanStore.get();
      if (st.phase === 'live') {
        if (st.mode === 'inventory') return; // count preview only (D9)
        safe(() => scanActions.freeze(id));
      }
      safe(() => scanActions.select(id));
      setHighlight({ key: null, ids: [id] });
      if (!openPartOf(id)) setChooser({ kind: 'detection', id });
    },
    [openPartOf],
  );

  const onBoxLongPress = useCallback((id: DetectionId) => {
    safe(() => scanActions.removePiece(id));
    safe(() => feedback.tap());
    setHighlight((h) => (h.ids.includes(id) ? { key: null, ids: NO_IDS } : h));
  }, []);

  const onBackgroundPress = useCallback((pt: Point) => {
    fire(() => scanActions.addManualBox(pt));
  }, []);

  const toggleFocusLock = useCallback(() => {
    const next = !cam.focusLocked;
    cam.setFocusLocked(next);
    showToast(next ? scanner.camera.focusLocked : scanner.camera.focusUnlocked);
  }, [cam, showToast]);

  const onRowPress = useCallback(
    (g: PileGroup) => {
      const first = g.detectionIds[0];
      if (!first) return;
      if (scanStore.get().phase === 'live') safe(() => scanActions.freeze(first));
      safe(() => scanActions.select(first));
      setHighlight({ key: g.key, ids: g.detectionIds });
      if (g.partId) router.push(routes.part(g.partId, g.colorId));
      else setChooser({ kind: 'group', key: g.key, ids: g.detectionIds });
    },
    [router],
  );

  const onBadgePress = useCallback((g: PileGroup) => {
    const first = g.detectionIds[0];
    if (!first) return;
    if (scanStore.get().phase === 'live') safe(() => scanActions.freeze(first));
    setHighlight({ key: g.key, ids: g.detectionIds });
    setChooser({ kind: 'group', key: g.key, ids: g.detectionIds });
  }, []);

  const onChoose = useCallback(
    async (target: ChooserTarget, c: Candidate) => {
      setChooser(null);
      try {
        await scanActions.chooseCandidate(target.kind === 'detection' ? { detectionId: target.id } : { groupKey: target.key }, c);
      } catch {
        safe(() => feedback.error());
        return;
      }
      if (target.kind === 'detection') openPartOf(target.id);
    },
    [openPartOf],
  );

  const doCapture = useCallback(async () => {
    if (capturing) return;
    setCapturing(true);
    safe(() => feedback.tap());
    flashCue();
    try {
      const photo = await cam.takePicture({ quality: VISION.picture.captureQuality }, true);
      if (!photo) {
        showToast(scanner.camera.captureFailed);
        return;
      }
      setDrawerSnap(0);
      setHighlight({ key: null, ids: NO_IDS });
      fire(() => scanActions.capture(photo));
    } catch {
      safe(() => feedback.error());
      showToast(scanner.camera.captureFailed);
    } finally {
      setCapturing(false);
    }
  }, [cam, capturing, flashCue, showToast]);

  const onModeChange = useCallback((m: ScanMode) => {
    safe(() => scanActions.setMode(m));
    safe(() => feedback.tap());
  }, []);

  const onValidate = useCallback(() => {
    safe(() => scanActions.startReview());
    router.push(routes.review);
  }, [router]);

  // Android back: collapse the drawer, then resume a frozen / analysing scan, else default behaviour.
  const drawerSnapRef = useRef(drawerSnapEff);
  useEffect(() => {
    drawerSnapRef.current = drawerSnapEff;
  });
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (drawerSnapRef.current > 0) {
          setDrawerSnap(0);
          return true;
        }
        if (scanStore.get().phase !== 'live') {
          resume();
          return true;
        }
        return false;
      });
      return () => sub.remove();
    }, [resume]),
  );

  // ---------- chooser data (always derived from the store) ----------
  const chooserData = useMemo(() => {
    if (!chooser) return null;
    if (chooser.kind === 'detection') {
      const piece = pieces.find((x) => x.detection.id === chooser.id);
      return {
        cropUri: piece?.cropUri ?? null,
        candidates: piece?.identification.candidates ?? [],
        pending: piece ? piece.identification.status === 'pending' : false,
        unavailable: piece?.identification.status === 'unavailable',
      };
    }
    const members = pieces.filter((x) => chooser.ids.includes(x.detection.id));
    let candidates: Candidate[] = [];
    try {
      candidates = lineCandidates(pieces, chooser.ids);
    } catch {
      candidates = [];
    }
    return {
      cropUri: members.find((m) => m.cropUri)?.cropUri ?? null,
      candidates,
      pending: members.length > 0 && members.every((m) => m.identification.status === 'pending'),
      unavailable: members.length > 0 && members.every((m) => m.identification.status === 'unavailable'),
    };
  }, [chooser, pieces]);

  const highlightedIds = useMemo(() => {
    if (highlight.ids.length > 0) return highlight.ids;
    return selectedId ? [selectedId] : NO_IDS;
  }, [highlight.ids, selectedId]);

  // ---------- render ----------
  if (!granted) {
    return (
      <View style={[s.root, { paddingTop: insets.top }]}>
        <CameraPermission permission={cam.permission} requestPermission={cam.requestPermission} />
      </View>
    );
  }

  const frozen = phase === 'frozen';
  const noticeBanner = notice ? (
    <Banner
      tone={notice === 'identification_unavailable' ? 'error' : notice === 'live_unavailable' ? 'warn' : 'info'}
      text={scanner.notices[notice]}
      actionLabel={notice === 'identification_unavailable' ? common.actions.retry : undefined}
      onAction={notice === 'identification_unavailable' ? () => fire(() => scanActions.retryUnavailable()) : undefined}
    />
  ) : null;

  return (
    <View style={s.root}>
      <View
        style={s.cameraArea}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          setViewSize((v) => (v && v.width === width && v.height === height ? v : { width, height }));
        }}
      >
        {cam.mountError ? (
          <View style={[s.fill, s.errorWrap]}>
            <ErrorState error={{ code: 'unknown', message: scanner.camera.mountError }} onRetry={cam.retryMount} />
          </View>
        ) : mountCamera ? (
          <CameraView
            key={cam.mountKey}
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing="back"
            enableTorch={cam.torch}
            autofocus={cam.focusLocked ? 'on' : 'off'}
            pictureSize={cam.pictureSize}
            animateShutter={false}
            onCameraReady={cam.onCameraReady}
            onMountError={cam.onMountError}
          />
        ) : (
          <View style={[s.fill, s.black]} />
        )}

        {!cam.mountError ? (
          <BoxOverlay
            frame={phase === 'analyzing' ? null : frame}
            pieces={phase === 'analyzing' ? [] : pieces}
            viewSize={viewSize}
            fit={frozen ? 'contain' : 'cover'}
            palette={palette}
            highlighted={highlightedIds}
            onBoxPress={phase === 'analyzing' || liveInventory ? undefined : onBoxPress}
            onBoxLongPress={frozen ? onBoxLongPress : undefined}
            onBackgroundPress={frozen ? onBackgroundPress : undefined}
            onBackgroundLongPress={phase === 'live' ? toggleFocusLock : undefined}
            backgroundHint={frozen ? scanner.box.manualHint : phase === 'live' ? scanner.camera.focusHint : undefined}
          />
        ) : null}

        {phase === 'analyzing' ? <View style={[s.fill, s.dim]} pointerEvents="none" /> : null}
        <Animated.View pointerEvents="none" style={[s.fill, s.flash, { opacity: flash }]} />

        {mountCamera && !cam.ready ? (
          <View style={s.startingWrap} pointerEvents="none">
            <Text style={s.starting}>{scanner.camera.starting}</Text>
          </View>
        ) : null}

        {/* Top bar: torch, focus lock, calibration, settings */}
        <View style={[s.topBar, { paddingTop: insets.top + spacing.xs }]} pointerEvents="box-none">
          <View style={s.topGroup}>
            <View style={s.roundBtn}>
              <IconButton
                icon={cam.torch ? 'flashlight' : 'flashlight-outline'}
                label={cam.torch ? scanner.camera.torchOff : scanner.camera.torchOn}
                active={cam.torch}
                onPress={() => cam.setTorch(!cam.torch)}
              />
            </View>
            <View style={s.roundBtn}>
              <IconButton
                icon={cam.focusLocked ? 'lock-closed' : 'lock-open-outline'}
                label={cam.focusLocked ? scanner.camera.focusUnlock : scanner.camera.focusLock}
                active={cam.focusLocked}
                onPress={toggleFocusLock}
              />
            </View>
          </View>
          <View style={s.topGroup}>
            {calibration ? (
              <View style={s.roundBtn}>
                <IconButton icon="flask-outline" label={scanner.camera.calibration} onPress={() => router.push(routes.calibration)} />
              </View>
            ) : null}
            <View style={s.roundBtn}>
              <IconButton icon="settings-outline" label={scanner.camera.settings} onPress={() => router.push(routes.settings)} />
            </View>
          </View>
        </View>

        {toast ? (
          <View style={[s.toast, { top: insets.top + 64 }]} pointerEvents="none" accessibilityLiveRegion="polite">
            <Text style={s.toastText}>{toast}</Text>
          </View>
        ) : null}

        {/* Notices above the drawer and the controls */}
        <View style={[s.notices, { bottom: drawerVisible(pieces.length) ? 72 : spacing.sm }]} pointerEvents="box-none">
          {noticeBanner}
          {portraitHint ? <Banner tone="info" text={scanner.camera.portraitHint} /> : null}
        </View>

        {viewSize ? (
          <PileDrawer
            containerHeight={viewSize.height}
            snap={drawerSnapEff}
            onSnapChange={setDrawerSnap}
            pieces={phase === 'analyzing' ? [] : pieces}
            palette={palette}
            countOnly={liveInventory}
            highlightedKey={highlight.key}
            onRowPress={onRowPress}
            onBadgePress={onBadgePress}
            reduceMotion={reduceMotion}
          />
        ) : null}
      </View>

      <ScanControls
        mode={mode}
        phase={phase}
        onModeChange={onModeChange}
        scanning={liveEnabled}
        manualAnalyze={manualAnalyze}
        canCapture={mountCamera && cam.ready}
        capturing={capturing}
        onShutter={() => void doCapture()}
        onAnalyze={() => void doCapture()}
        onResume={resume}
        validateCount={pieces.length}
        onValidate={onValidate}
      />

      {chooser && chooserData ? (
        <CandidateChooser
          visible
          onClose={() => setChooser(null)}
          cropUri={chooserData.cropUri}
          candidates={chooserData.candidates}
          pending={chooserData.pending}
          unavailable={chooserData.unavailable}
          onChoose={(c) => void onChoose(chooser, c)}
        />
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  cameraArea: { flex: 1, backgroundColor: '#000', overflow: 'hidden' },
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  black: { backgroundColor: '#000' },
  errorWrap: { justifyContent: 'center', padding: spacing.xl, backgroundColor: colors.bg },
  dim: { backgroundColor: colors.overlay },
  flash: { backgroundColor: colors.white },
  startingWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  starting: { color: colors.muted, fontSize: font.small },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
  },
  topGroup: { flexDirection: 'row', gap: spacing.sm },
  roundBtn: { borderRadius: radius.pill, backgroundColor: colors.overlay },
  toast: {
    position: 'absolute',
    alignSelf: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.overlay,
  },
  toastText: { color: colors.white, fontSize: font.small, fontWeight: '600' },
  notices: { position: 'absolute', left: spacing.md, right: spacing.md, gap: spacing.sm },
});
