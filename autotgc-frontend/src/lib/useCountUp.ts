/**
 * useCountUp — animate a number from 0 → target with an ease-out curve.
 *
 * Respects `prefers-reduced-motion`: when the user prefers reduced motion (or
 * the value isn't finite) the hook returns the final value immediately with no
 * animation. Used by KPI stat cards for a subtle count-up on mount/update.
 */
import { useEffect, useRef, useState } from 'react';

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useCountUp(target: number, durationMs = 700): number {
  const finite = Number.isFinite(target) ? target : 0;
  const [value, setValue] = useState(() => (prefersReducedMotion() ? finite : 0));
  const frameRef = useRef<number | null>(null);
  const fromRef = useRef(0);

  useEffect(() => {
    if (prefersReducedMotion()) {
      setValue(finite);
      return;
    }

    const from = fromRef.current;
    const start = performance.now();

    const tick = (now: number) => {
      const elapsed = now - start;
      const t = Math.min(1, elapsed / durationMs);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      const current = from + (finite - from) * eased;
      setValue(current);
      if (t < 1) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = finite;
      }
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      fromRef.current = finite;
    };
  }, [finite, durationMs]);

  return value;
}
