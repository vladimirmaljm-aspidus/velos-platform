"use client";

import { useEffect, useState } from "react";

/**
 * Returns a debounced copy of `value` that only updates after `delayMs`
 * milliseconds have elapsed without further changes. Used to throttle
 * search inputs so we don't fire a server fetch on every keystroke.
 *
 * Extracted from `src/components/layout/global-search.tsx` so all views
 * can share one implementation.
 */
export function useDebounced<T>(value: T, delayMs: number = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
