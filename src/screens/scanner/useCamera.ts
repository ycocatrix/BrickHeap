// Camera state of the scanner (WP4, §4.6, D3): permission, mount/ready, picture size, single-flight capture.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { AppState, Platform } from 'react-native';
import { useIsFocused } from 'expo-router';
import { useCameraPermissions, type CameraPictureOptions, type CameraView, type PermissionResponse } from 'expo-camera';
import type { ScanFrame } from '@/domain/types';
import { pickPictureSize } from '@/domain/vision/geometry';
import { VISION } from '@/domain/vision/config';
import { kv } from '@/services/kv';
import { useSetting } from '@/state/settings';

const SIZE_KEY = 'camera.pictureSize';
/** Delay between the screen gaining focus and the camera mounting (longer than the stack pop animation). */
const MOUNT_SETTLE_MS = 450;
const IOS_PICTURE_SIZE = '1920x1080';
/** If the rebind after a picture-size change never reports ready again, assume it is ready after this delay. */
const REBIND_READY_FALLBACK_MS = 2000;
/** The shutter waits at most this long for an in-flight live snapshot to finish. */
const BUSY_WAIT_MS = 4000;

/** Android: sizes are queried at most once per app run (and once per install thanks to the kv entry). */
let sizeQueried = false;

function initialPictureSize(): string | undefined {
  if (Platform.OS === 'ios') return IOS_PICTURE_SIZE;
  if (Platform.OS !== 'android') return undefined;
  const saved = kv.getString(SIZE_KEY);
  // '' = queried before, no usable size → camera default.
  return saved ? saved : undefined;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface CameraController {
  permission: PermissionResponse | null;
  requestPermission: () => Promise<PermissionResponse>;
  /** Tab focused and app in the foreground: CameraView may be mounted. */
  active: boolean;
  /** onCameraReady received for the current binding. */
  ready: boolean;
  pictureSize: string | undefined;
  mountError: string | null;
  /** Changes on « Réessayer » after a mount error, to remount CameraView. */
  mountKey: number;
  torch: boolean;
  setTorch: (v: boolean) => void;
  focusLocked: boolean;
  setFocusLocked: (v: boolean) => void;
  onCameraReady: () => void;
  onMountError: (e: { message: string }) => void;
  retryMount: () => void;
  /** Single-flight capture. Returns null when the camera is not ready or another capture is in flight
   *  (`waitIfBusy` waits for it first). Rejections of takePictureAsync propagate (live loop: 'failed'). */
  takePicture: (opts: CameraPictureOptions, waitIfBusy?: boolean) => Promise<ScanFrame | null>;
}

/** `ref` is the CameraView ref owned by the screen (kept out of the returned object for the React Compiler). */
export function useCamera(ref: RefObject<CameraView | null>): CameraController {
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const focused = useIsFocused();
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [ready, setReady] = useState(false);
  const [pictureSize, setPictureSize] = useState<string | undefined>(initialPictureSize);
  const [mountError, setMountError] = useState<string | null>(null);
  const [mountKey, setMountKey] = useState(0);
  const torchOnLaunch = useSetting('torchOnLaunch');
  const [torch, setTorch] = useState(torchOnLaunch);
  const [focusLocked, setFocusLocked] = useState(false);
  const busy = useRef(false);
  const readyRef = useRef(false);
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mount the native preview only once the screen has settled: mounting it while a stack screen is still sliding
  // away (e.g. back from the review) leaves Android's PreviewView mis-sized (squashed, letterboxed) for the whole
  // session. Unmounting stays immediate.
  const wantActive = focused && appActive;
  const [settled, setSettled] = useState(false);
  if (!wantActive && settled) setSettled(false); // state adjusted during render
  useEffect(() => {
    if (!wantActive) return undefined;
    const timer = setTimeout(() => setSettled(true), MOUNT_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [wantActive]);
  const active = wantActive && settled;

  const setReadyBoth = useCallback((v: boolean) => {
    readyRef.current = v;
    setReady(v);
  }, []);

  // App state: the camera is unmounted in the background; permission re-read when coming back (settings app).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      setAppActive(s === 'active');
      if (s === 'active') getPermission().catch(() => undefined);
    });
    return () => sub.remove();
  }, [getPermission]);

  // Unmounted camera → not ready; the next mount reports ready again (state adjusted during render).
  const [prevActive, setPrevActive] = useState(active);
  if (prevActive !== active) {
    setPrevActive(active);
    if (!active) setReady(false);
  }
  useEffect(() => {
    if (!active) readyRef.current = false;
  }, [active]);

  useEffect(
    () => () => {
      if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
    },
    [],
  );

  const querySizeOnce = useCallback(async () => {
    if (Platform.OS !== 'android' || sizeQueried || kv.getString(SIZE_KEY) !== null) return;
    sizeQueried = true;
    let chosen: string | undefined;
    try {
      const sizes = (await ref.current?.getAvailablePictureSizesAsync()) ?? [];
      chosen = pickPictureSize(sizes, VISION.picture.longSide);
    } catch {
      chosen = undefined;
    }
    try {
      kv.setString(SIZE_KEY, chosen ?? '');
    } catch {
      // kv unavailable: the size is simply queried again on the next launch.
    }
    if (chosen && chosen !== pictureSize) {
      // Changing pictureSize rebinds the session: wait for the second onCameraReady (it never re-queries).
      setReadyBoth(false);
      setPictureSize(chosen);
      if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
      fallbackTimer.current = setTimeout(() => setReadyBoth(true), REBIND_READY_FALLBACK_MS);
    }
  }, [pictureSize, ref, setReadyBoth]);

  const onCameraReady = useCallback(() => {
    if (fallbackTimer.current) {
      clearTimeout(fallbackTimer.current);
      fallbackTimer.current = null;
    }
    setMountError(null);
    setReadyBoth(true);
    void querySizeOnce();
  }, [querySizeOnce, setReadyBoth]);

  const onMountError = useCallback(
    (e: { message: string }) => {
      setReadyBoth(false);
      setMountError(e?.message || 'mount error');
    },
    [setReadyBoth],
  );

  const retryMount = useCallback(() => {
    setMountError(null);
    setReadyBoth(false);
    setMountKey((k) => k + 1);
  }, [setReadyBoth]);

  const takePicture = useCallback(
    async (opts: CameraPictureOptions, waitIfBusy = false): Promise<ScanFrame | null> => {
      if (busy.current && waitIfBusy) {
        const until = Date.now() + BUSY_WAIT_MS;
        while (busy.current && Date.now() < until) await sleep(50);
      }
      const cam = ref.current;
      if (!cam || !readyRef.current || busy.current) return null;
      busy.current = true;
      try {
        const p = await cam.takePictureAsync({ ...opts, skipProcessing: false });
        if (!p || !p.uri || !(p.width > 0) || !(p.height > 0)) throw new Error('empty picture');
        return { uri: p.uri, width: p.width, height: p.height };
      } finally {
        busy.current = false;
      }
    },
    [ref],
  );

  return {
    permission,
    requestPermission,
    active,
    ready,
    pictureSize,
    mountError,
    mountKey,
    torch,
    setTorch,
    focusLocked,
    setFocusLocked,
    onCameraReady,
    onMountError,
    retryMount,
    takePicture,
  };
}
