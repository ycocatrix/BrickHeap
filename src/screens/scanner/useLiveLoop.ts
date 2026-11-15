// Adaptive live loop (D9, §4.6): single-flight snapshot → scanActions.ingestLiveSnapshot → adaptLive.
import { useEffect, useRef, useState } from 'react';
import type { CameraPictureOptions } from 'expo-camera';
import type { ScanFrame, Size } from '@/domain/types';
import { VISION } from '@/domain/vision/config';
import { orientationMatches } from '@/domain/vision/geometry';
import { adaptLive, INITIAL_LIVE_TUNING, type LiveTuning } from '@/domain/vision/live';
import { scanActions } from '@/state/scanStore';
import { nextPortraitStreak, nextTickDelay, PORTRAIT_HINT_AFTER } from './scannerLogic';

/** Kept for the whole app run (reset at app start only, §4.6). */
let tuning: LiveTuning = INITIAL_LIVE_TUNING;
const FIRST_TICK_DELAY_MS = 400;

type Outcome = 'ok' | 'skipped' | 'failed';

export function useLiveLoop(opts: {
  enabled: boolean;
  viewSize: Size | null;
  takePicture: (o: CameraPictureOptions) => Promise<ScanFrame | null>;
}): { portraitHint: boolean } {
  const { enabled, viewSize, takePicture } = opts;
  const [portraitHint, setPortraitHint] = useState(false);
  const viewRef = useRef(viewSize);
  const takeRef = useRef(takePicture);
  useEffect(() => {
    viewRef.current = viewSize;
    takeRef.current = takePicture;
  });
  // The hint is cleared whenever the loop stops (state adjusted during render).
  const [prevEnabled, setPrevEnabled] = useState(enabled);
  if (prevEnabled !== enabled) {
    setPrevEnabled(enabled);
    if (!enabled) setPortraitHint(false);
  }
  const hasView = viewSize !== null && viewSize.width > 0 && viewSize.height > 0;

  useEffect(() => {
    if (!enabled || !hasView || tuning.disabled) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let streak = 0;

    const tick = async () => {
      timer = null;
      if (cancelled) return;
      const start = Date.now();
      let outcome: Outcome;
      try {
        const photo = await takeRef.current({ quality: VISION.picture.liveQuality, shutterSound: false });
        const view = viewRef.current;
        if (!photo || !view) {
          outcome = 'skipped'; // camera busy (shutter) or not ready: not a failure
        } else {
          // Always handed to the store, even after cancellation: it deletes photos it does not keep.
          outcome = await scanActions.ingestLiveSnapshot(photo, view, tuning.segMaxSide);
          let matches = true;
          try {
            matches = orientationMatches(photo, view);
          } catch {
            matches = true;
          }
          streak = nextPortraitStreak(streak, matches);
          if (!cancelled) setPortraitHint(streak >= PORTRAIT_HINT_AFTER);
        }
      } catch {
        outcome = 'failed';
      }
      const cycleMs = Date.now() - start;
      tuning = adaptLive(tuning, { outcome, cycleMs });
      if (tuning.disabled) {
        scanActions.reportLiveFailure();
        return;
      }
      if (cancelled) return;
      timer = setTimeout(() => void tick(), nextTickDelay(tuning.intervalMs, cycleMs));
    };

    timer = setTimeout(() => void tick(), FIRST_TICK_DELAY_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, hasView]);

  return { portraitHint: enabled && portraitHint };
}
