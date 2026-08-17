"use client";

import * as React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useAppStore, ViewKey } from "@/lib/store/app-store";
import { useSearchStore } from "@/components/layout/global-search";
import { useT } from "@/lib/i18n/store";

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border bg-muted px-1.5 font-mono text-xs text-muted-foreground">
      {children}
    </kbd>
  );
}

const CHORD_TIMEOUT_MS = 800;

const NAV_CHORDS: Record<string, ViewKey> = {
  d: "dashboard",
  p: "partners",
  o: "offers",
  i: "invoices",
  c: "commissions",
  t: "tasks",
  l: "logistics-requests",
  s: "settings",
  a: "audit",
  u: "users",
};

/**
 * Global keyboard shortcuts:
 *   /            focus global search
 *   ?            open shortcuts help
 *   g d          go to Dashboard
 *   g p          go to Partners
 *   g o          go to Offers
 *   g i          go to Invoices
 *   g c          go to Commissions
 *   g t          go to Tasks
 *   g l          go to Logistics Requests
 *   g s          go to Settings
 *   g a          go to Audit Log
 *   g u          go to Users
 *   n            fires a custom event ("velos:new") — every list view
 *                listens and clicks its primary "New …" button
 *
 * ⌘K / Ctrl+K is registered separately by global-search.tsx.
 *
 * All shortcuts are ignored when focus is inside an input, textarea, or
 * contenteditable element so typing is never hijacked.
 */
export function KeyboardShortcuts() {
  const setView = useAppStore((s) => s.setView);
  const setSelectedId = useAppStore((s) => s.setSelectedId);
  const [helpOpen, setHelpOpen] = React.useState(false);
  const chordRef = React.useRef<{ prefix: string; until: number } | null>(null);
  const t = useT();

  React.useEffect(() => {
    function isTypingContext(el: EventTarget | null): boolean {
      if (!el || !(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (el.isContentEditable) return true;
      return false;
    }

    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return; // don't clobber ⌘K etc.
      if (isTypingContext(e.target)) return;

      // Chord in progress: waiting for the second key of "g X"
      if (chordRef.current && Date.now() < chordRef.current.until) {
        const target = NAV_CHORDS[e.key.toLowerCase()];
        if (chordRef.current.prefix === "g" && target) {
          e.preventDefault();
          setSelectedId(null);
          setView(target);
        }
        chordRef.current = null;
        return;
      }
      chordRef.current = null;

      switch (e.key) {
        case "/":
          e.preventDefault();
          useSearchStore.getState().toggle();
          break;
        case "?":
          e.preventDefault();
          setHelpOpen(true);
          break;
        case "n":
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("velos:new"));
          break;
        case "g":
          e.preventDefault();
          chordRef.current = { prefix: "g", until: Date.now() + CHORD_TIMEOUT_MS };
          break;
        case "Escape":
          if (helpOpen) setHelpOpen(false);
          break;
      }
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true } as any);
  }, [setView, setSelectedId, helpOpen]);

  return (
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("misc-keyboard-shortcuts-title")}</DialogTitle>
          <DialogDescription>{t("misc-keyboard-shortcuts-desc")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          <Row keys={["⌘", "K"]} desc="Open global search" />
          <Row keys={["/"]} desc="Focus search" />
          <Row keys={["?"]} desc="Show this help" />
          <Row keys={["n"]} desc="New item on the current list view" />
          <div className="pt-2 border-t text-xs uppercase text-muted-foreground">Go to</div>
          <Row keys={["g", "d"]} desc="Dashboard" />
          <Row keys={["g", "p"]} desc="Partners" />
          <Row keys={["g", "o"]} desc="Offers" />
          <Row keys={["g", "i"]} desc="Invoices" />
          <Row keys={["g", "c"]} desc="Commissions" />
          <Row keys={["g", "t"]} desc="Tasks" />
          <Row keys={["g", "l"]} desc="Logistics Requests" />
          <Row keys={["g", "s"]} desc="Settings" />
          <Row keys={["g", "a"]} desc="Audit Log" />
          <Row keys={["g", "u"]} desc="Users" />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Row({ keys, desc }: { keys: string[]; desc: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{desc}</span>
      <div className="flex items-center gap-1">
        {keys.map((k, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="text-muted-foreground text-xs">then</span>}
            <Kbd>{k}</Kbd>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
