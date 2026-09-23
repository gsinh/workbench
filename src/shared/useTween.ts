"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A number that eases to its new value instead of jumping, so a headline
 * figure visibly counts up or down when something changes it. Under
 * prefers-reduced-motion it jumps.
 */
export function useTween(value: number, durationMs = 300): number {
  const [shown, setShown] = useState(value);
  const current = useRef(value);

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      current.current = value;
      setShown(value);
      return;
    }
    const from = current.current;
    const started = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / durationMs);
      const eased = 1 - (1 - t) ** 3;
      current.current = from + (value - from) * eased;
      setShown(current.current);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, durationMs]);

  return shown;
}
