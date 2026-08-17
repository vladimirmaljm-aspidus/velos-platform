"use client";

import * as React from "react";

/**
 * Bind the global "n" keyboard shortcut (dispatched as the "velos:new"
 * CustomEvent by KeyboardShortcuts) to a view-local "create" handler.
 * Handler runs only while the component is mounted.
 */
export function useNewShortcut(onNew: () => void) {
  const ref = React.useRef(onNew);
  // Keep the ref in sync with the latest `onNew` via an effect rather than a
  // render-phase write (React 19 anti-pattern, P1-9). The listener below reads
  // `ref.current` at event-dispatch time, so it always sees the freshest value.
  React.useEffect(() => {
    ref.current = onNew;
  });
  React.useEffect(() => {
    function handle() { ref.current(); }
    window.addEventListener("velos:new", handle);
    return () => window.removeEventListener("velos:new", handle);
  }, []);
}
