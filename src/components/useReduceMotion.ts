// Internal helper of the UI kit: animations are skipped when the system asks for reduced motion (§7.2-8).
import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/** Animation duration used by the kit (§7.2-8: ≤ 250 ms). */
export const ANIM_MS = 200;

export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => {
        if (alive) setReduce(v);
      })
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v: boolean) => setReduce(v));
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduce;
}
