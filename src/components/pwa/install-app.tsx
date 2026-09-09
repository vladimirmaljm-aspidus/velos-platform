"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Download, MonitorSmartphone, Smartphone, Share, PlusCircle, CheckCircle2, Loader2 } from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { toast } from "sonner";

/**
 * PWA install — the user-facing "Install app" capability.
 *
 * VELOS is a fully installable PWA (manifest.json + service worker +
 * offline page already ship). What was missing was the UI: a visible,
 * discoverable way to install the platform on desktop or phone.
 *
 * Browser support matrix (2026):
 *   • Chrome / Edge / Brave / Opera (desktop + Android) → fire
 *     `beforeinstallprompt`; we capture it and show a native install
 *     dialog via `prompt()`.
 *   • Safari iOS → never fires `beforeinstallprompt`. The ONLY way is
 *     Share → Add to Home Screen, so we show step-by-step instructions.
 *   • Firefox desktop → no PWA install; we show a manual fallback
 *     (browser "Install site as app"-style guidance is not available,
 *     so the dialog explains the shortcut alternative).
 *   • Already installed (display-mode: standalone / appinstalled) →
 *     nothing is shown.
 *
 * Components:
 *   • useInstallPrompt()        — the shared hook (state machine).
 *   • <InstallAppHeaderButton/> — compact ghost icon-button for headers.
 *   • <InstallAppMenuItem/>     — dropdown row for user menus.
 *   • <InstallAppDialog/>       — the dialog itself (prompt / iOS steps /
 *                                 generic how-to).
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

type InstallState = "checking" | "supported" | "ios" | "unsupported" | "installed";

function detectIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  // iOS Safari: Macintosh + touch (iPadOS 13+ pretends to be desktop Safari).
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && typeof (navigator as { maxTouchPoints?: number }).maxTouchPoints === "number" && (navigator as { maxTouchPoints: number }).maxTouchPoints > 1)
  );
}

function detectStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.matchMedia?.("(display-mode: window-controls-overlay)").matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

function useInstallPrompt() {
  const [deferred, setDeferred] = React.useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = React.useState(false);
  const [ios, setIos] = React.useState(false);
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    // The manifest must be processed before the browser will offer
    // beforeinstallprompt — on a cold load that can race with hydration.
    // Deferred to a rAF callback: synchronous setState inside the effect
    // can cascade renders during hydration (and trips the
    // react-hooks/set-state-in-effect lint rule); one frame later is
    // imperceptible to the user and hydration-safe.
    const raf = requestAnimationFrame(() => {
      setInstalled(detectStandalone());
      setIos(detectIOS());
      setReady(true);
    });

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setDeferred(null);
      setInstalled(true);
      setReady(true);
    };
    const onModeChange = (e: MediaQueryListEvent) => {
      if (e.matches) onInstalled();
    };

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    const mq = window.matchMedia?.("(display-mode: standalone)");
    mq?.addEventListener?.("change", onModeChange);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      mq?.removeEventListener?.("change", onModeChange);
    };
  }, []);

  const state: InstallState = !ready
    ? "checking"
    : installed
      ? "installed"
      : deferred
        ? "supported"
        : ios
          ? "ios"
          : "unsupported";

  const triggerInstall = React.useCallback(async (): Promise<"accepted" | "dismissed" | "failed"> => {
    if (!deferred) return "failed";
    try {
      await deferred.prompt();
      const { outcome } = await deferred.userChoice;
      if (outcome === "accepted") setInstalled(true);
      setDeferred(null); // the event is single-use
      return outcome;
    } catch {
      return "failed";
    }
  }, [deferred]);

  return { state, triggerInstall, showable: state === "supported" || state === "ios" };
}

/** Shared dialog — rendered by the header button / menu item / banner. */
function InstallAppDialog({
  open,
  onOpenChange,
  state,
  triggerInstall,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  state: InstallState;
  triggerInstall: () => Promise<"accepted" | "dismissed" | "failed">;
}) {
  const t = useT();
  const [installing, setInstalling] = React.useState(false);

  const onInstall = async () => {
    setInstalling(true);
    const outcome = await triggerInstall();
    setInstalling(false);
    if (outcome === "accepted") {
      toast.success(t("misc-pwa-toast-installed"));
      onOpenChange(false);
    } else if (outcome === "dismissed") {
      // User closed the native prompt — keep our dialog open so the manual
      // steps remain available.
      toast.info(t("misc-pwa-toast-dismissed"));
    } else {
      // Chrome sometimes doesn't re-offer prompt() — fall through to the
      // manual instructions which are already visible in this dialog.
      toast.info(t("misc-pwa-toast-manual"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MonitorSmartphone className="size-5 text-primary" />
            {t("misc-pwa-dialog-title")}
          </DialogTitle>
          <DialogDescription>{t("misc-pwa-dialog-description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Benefits */}
          <ul className="space-y-2">
            {[
              { icon: Smartphone, text: t("misc-pwa-benefit-app") },
              { icon: MonitorSmartphone, text: t("misc-pwa-benefit-desktop") },
              { icon: CheckCircle2, text: t("misc-pwa-benefit-offline") },
            ].map((b) => (
              <li key={b.text} className="flex items-start gap-2.5 text-sm">
                <b.icon className="size-4 text-primary mt-0.5 shrink-0" />
                <span>{b.text}</span>
              </li>
            ))}
          </ul>

          {/* One-click (Chromium) */}
          {state === "supported" && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
              <p className="text-sm font-medium mb-1">{t("misc-pwa-one-click-title")}</p>
              <p className="text-xs text-muted-foreground">{t("misc-pwa-one-click-desc")}</p>
            </div>
          )}

          {/* iOS / manual steps */}
          {state !== "supported" && (
            <div className="rounded-lg border border-border/60 bg-muted/40 p-3 space-y-2">
              {state === "ios" ? (
                <>
                  <p className="text-sm font-medium">{t("misc-pwa-ios-title")}</p>
                  <ol className="space-y-2 text-sm">
                    <li className="flex items-start gap-2">
                      <span className="inline-flex items-center justify-center size-5 rounded-full bg-primary/15 text-primary text-xs font-bold shrink-0">1</span>
                      {t("misc-pwa-ios-step-1")}
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="inline-flex items-center justify-center size-5 rounded-full bg-primary/15 text-primary text-xs font-bold shrink-0">2</span>
                      <span className="inline-flex items-center gap-1.5 flex-wrap">
                        {t("misc-pwa-ios-step-2")}
                        <Share className="size-3.5 text-primary" />
                        <span className="text-muted-foreground text-xs">{t("misc-pwa-ios-step-2-share")}</span>
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="inline-flex items-center justify-center size-5 rounded-full bg-primary/15 text-primary text-xs font-bold shrink-0">3</span>
                      <span className="inline-flex items-center gap-1.5 flex-wrap">
                        {t("misc-pwa-ios-step-3")}
                        <PlusCircle className="size-3.5 text-primary" />
                        <span className="text-muted-foreground text-xs">{t("misc-pwa-ios-step-3-add")}</span>
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="inline-flex items-center justify-center size-5 rounded-full bg-primary/15 text-primary text-xs font-bold shrink-0">4</span>
                      {t("misc-pwa-ios-step-4")}
                    </li>
                  </ol>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium">{t("misc-pwa-manual-title")}</p>
                  <ol className="space-y-2 text-sm">
                    <li className="flex items-start gap-2">
                      <span className="inline-flex items-center justify-center size-5 rounded-full bg-primary/15 text-primary text-xs font-bold shrink-0">1</span>
                      {t("misc-pwa-manual-step-1")}
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="inline-flex items-center justify-center size-5 rounded-full bg-primary/15 text-primary text-xs font-bold shrink-0">2</span>
                      {t("misc-pwa-manual-step-2")}
                    </li>
                  </ol>
                </>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common-label-cancel")}
          </Button>
          {state === "supported" && (
            <Button onClick={onInstall} disabled={installing}>
              {installing ? <Loader2 className="size-4 mr-1.5 animate-spin" /> : <Download className="size-4 mr-1.5" />}
              {t("misc-pwa-install-button")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Compact header icon-button — renders ONLY when installation is possible. */
export function InstallAppHeaderButton() {
  const { state, triggerInstall, showable } = useInstallPrompt();
  const t = useT();
  const [open, setOpen] = React.useState(false);
  if (!showable) return null;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5 h-9 px-2.5"
        onClick={() => setOpen(true)}
        title={t("misc-pwa-install-button")}
        aria-label={t("misc-pwa-install-button")}
      >
        <Download className="size-4 text-primary" />
      </Button>
      <InstallAppDialog open={open} onOpenChange={setOpen} state={state} triggerInstall={triggerInstall} />
    </>
  );
}

/** User-menu dropdown row — always visible (even when only manual steps
 *  apply) so the capability is discoverable; shows "Installed" state. */
export function InstallAppMenuItem() {
  const { state, triggerInstall } = useInstallPrompt();
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const installed = state === "installed";
  return (
    <>
      <DropdownMenuItem
        className="gap-2 cursor-pointer rounded-md px-2 py-1.5 text-sm"
        onClick={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
        disabled={installed}
      >
        {installed ? <CheckCircle2 className="size-4 text-emerald-600" /> : <MonitorSmartphone className="size-4 text-muted-foreground" />}
        {installed ? t("misc-pwa-installed-label") : t("misc-pwa-menu-install")}
      </DropdownMenuItem>
      <InstallAppDialog open={open} onOpenChange={setOpen} state={state} triggerInstall={triggerInstall} />
    </>
  );
}
