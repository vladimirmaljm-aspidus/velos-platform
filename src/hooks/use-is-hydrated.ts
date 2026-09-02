"use client";

import { useSyncExternalStore } from "react";

/**
 * useIsHydrated — true only AFTER React finished hydrating this tree.
 *
 * WHY NOT `useState(false) + useEffect(() => setMounted(true))`?
 * That classic pattern breaks under STREAMING SSR + Suspense: React can
 * commit an earlier part of the tree (flushing effects → mounted=true)
 * while a LATER chunk is still hydrating. The still-hydrating section
 * then compares its server HTML against a client render that already
 * includes the "mounted" output → hydration mismatch #418 (observed on
 * the portal login page: the language-selector buttons appeared in the
 * client render before hydration finished).
 *
 * useSyncExternalStore is the React-team-recommended primitive for this:
 * `getServerSnapshot` (false) is used BOTH on the server AND during the
 * entire hydration pass; React then re-reads the client snapshot (true)
 * in a follow-up render — guaranteed ordering, no mismatch.
 *
 * Usage:
 *   const hydrated = useIsHydrated();
 *   if (!hydrated) return null; // or a skeleton
 */
const emptySubscribe = () => () => {};

export function useIsHydrated(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true, // client snapshot — post-hydration
    () => false, // server + hydration snapshot
  );
}
