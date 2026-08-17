"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  ShieldCheck, Loader2, QrCode, Copy, Check, KeyRound, AlertTriangle, RefreshCw,
} from "lucide-react";
import { toast } from "sonner";

/**
 * TwoFactorSetup — settings-page card for managing 2FA / TOTP on the
 * authenticated user's own account.
 *
 * Three states:
 *   1. NOT_ACTIVE — show "Enable 2FA" button.
 *   2. ENROLLING  — QR + verification input + recovery-code display.
 *   3. ACTIVE     — show "Disable 2FA" button (requires password or
 *                   TOTP) + "Use recovery code" link.
 *
 * CRITICAL: super_admin MAY use this card to enable 2FA on their own
 * account (it's their choice), but the login route bypasses the 2FA
 * check for super_admin regardless. A small banner at the bottom of the
 * card explains this when the current user is super_admin.
 */
export function TwoFactorSetup({ isSuperAdmin }: { isSuperAdmin?: boolean }) {
  const [status, setStatus] = useState<"loading" | "active" | "inactive">("loading");
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/auth/me");
      if (!r.ok) {
        setStatus("inactive");
        return;
      }
      const data = await r.json();
      // /api/auth/me returns the SafeUser shape; the totp_enabled flag
      // is exposed there for this UI. If the field isn't present we
      // default to "inactive" — the user can still enroll.
      setStatus(data?.user?.totp_enabled ? "active" : "inactive");
    } catch {
      setStatus("inactive");
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  if (status === "loading") {
    return (
      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-6">
          <div className="flex items-center gap-3 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span className="text-sm">Loading 2FA status…</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border/60 shadow-soft rounded-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-5" />
          Two-Factor Authentication
        </CardTitle>
        <CardDescription>
          Add a second factor (TOTP / authenticator app) to your account. Required for admins in security-conscious deployments.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-md border border-border/60 p-4">
          <div className="space-y-1">
            <div className="text-sm font-medium">Status</div>
            <div className="flex items-center gap-2">
              {status === "active" ? (
                <>
                  <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/15">Active</Badge>
                  <span className="text-xs text-muted-foreground">TOTP required at every login.</span>
                </>
              ) : (
                <>
                  <Badge variant="secondary">Not enabled</Badge>
                  <span className="text-xs text-muted-foreground">Login uses password only.</span>
                </>
              )}
            </div>
          </div>
          {status === "active" ? (
            <Button variant="outline" size="sm" onClick={() => setDisableOpen(true)}>
              Disable 2FA
            </Button>
          ) : (
            <Button size="sm" onClick={() => setEnrollOpen(true)}>
              <QrCode className="size-4 mr-1" /> Enable 2FA
            </Button>
          )}
        </div>

        {isSuperAdmin && (
          <Alert>
            <AlertTriangle className="size-4" />
            <AlertDescription className="text-xs">
              You are signed in as <strong>super admin</strong>. 2FA is optional for your account — the login route bypasses the TOTP prompt for super admins regardless of this setting, so you can always get in with just your password.
            </AlertDescription>
          </Alert>
        )}

        <EnrollDialog open={enrollOpen} onOpenChange={setEnrollOpen} onSuccess={() => { setStatus("active"); setEnrollOpen(false); }} />
        <DisableDialog open={disableOpen} onOpenChange={setDisableOpen} onSuccess={() => { setStatus("inactive"); setDisableOpen(false); }} />
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EnrollDialog
// ─────────────────────────────────────────────────────────────────────────────

interface EnrollResponse {
  qrUri: string;
  secret: string;
  recoveryCodes: string[];
  message?: string;
}

function EnrollDialog({
  open, onOpenChange, onSuccess,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSuccess: () => void;
}) {
  const [step, setStep] = useState<"loading" | "qr" | "verifying" | "done">("loading");
  const [data, setData] = useState<EnrollResponse | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [copied, setCopied] = useState(false);

  // Start enrollment when the dialog opens.
  useEffect(() => {
    if (!open) return;
    setStep("loading");
    setData(null);
    setToken("");
    setError("");
    setQrDataUrl("");
    void startEnroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function startEnroll() {
    try {
      const r = await fetch("/api/auth/2fa/enroll", { method: "POST" });
      const body = await r.json();
      if (!r.ok) {
        setError(body?.error || "Failed to start enrollment.");
        setStep("qr"); // show error in the QR step UI
        return;
      }
      setData(body);
      setStep("qr");
      // Render the otpauth:// URI to a QR data URL client-side. The
      // `qrcode` library is isomorphic and works in the browser.
      try {
        const QRCode = (await import("qrcode")).default;
        const url = await QRCode.toDataURL(body.qrUri, {
          width: 200,
          margin: 1,
          color: { dark: "#000000", light: "#ffffff" },
          errorCorrectionLevel: "M",
        });
        setQrDataUrl(url);
      } catch (e) {
        console.error("[2fa] QR render failed:", e);
        // Non-fatal — the secret is shown as text for manual entry.
      }
    } catch (e) {
      console.error("[2fa.enroll]", e);
      setError("Network error.");
      setStep("qr");
    }
  }

  async function verify() {
    if (!data || !token.trim()) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/auth/2fa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim(), recoveryCodes: data.recoveryCodes }),
      });
      const body = await r.json();
      if (!r.ok) {
        setError(body?.error || "Invalid token.");
        return;
      }
      setStep("done");
      toast.success("Two-factor authentication enabled.");
      setTimeout(() => onSuccess(), 1500);
    } catch (e) {
      console.error("[2fa.verify]", e);
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  }

  function copyCodes() {
    if (!data) return;
    void navigator.clipboard.writeText(data.recoveryCodes.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Enable Two-Factor Authentication</DialogTitle>
          <DialogDescription>
            Scan the QR code with your authenticator app (Google Authenticator, Authy, 1Password, etc.), then enter the 6-digit code it generates.
          </DialogDescription>
        </DialogHeader>

        {step === "loading" && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {step === "qr" && data && (
          <div className="space-y-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-col items-center gap-3">
              {qrDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qrDataUrl} alt="2FA QR code" width={200} height={200} className="rounded-md border" />
              ) : (
                <div className="size-[200px] flex items-center justify-center rounded-md border text-xs text-muted-foreground p-4 text-center">
                  QR rendering failed. Use the secret below to manually add the entry in your authenticator app.
                </div>
              )}
              <div className="text-xs text-muted-foreground break-all max-w-xs text-center">
                Secret: <code className="font-mono">{data.secret}</code>
              </div>
            </div>

            <div className="border-t border-border/60 pt-4">
              <div className="flex items-center justify-between mb-2">
                <Label className="flex items-center gap-1 text-sm font-medium">
                  <KeyRound className="size-4" /> Recovery codes
                </Label>
                <Button variant="ghost" size="sm" onClick={copyCodes}>
                  {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                  {copied ? "Copied" : "Copy all"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mb-2">
                Save these now. Each can be used once in place of a TOTP token if you lose your authenticator.
              </p>
              <div className="grid grid-cols-2 gap-1 max-h-32 overflow-y-auto rounded border bg-muted/30 p-2">
                {data.recoveryCodes.map((c, i) => (
                  <code key={i} className="font-mono text-[10px]">{c}</code>
                ))}
              </div>
            </div>

            <div className="space-y-2 border-t border-border/60 pt-4">
              <Label htmlFor="2fa-token">Enter 6-digit code</Label>
              <Input
                id="2fa-token"
                value={token}
                onChange={(e) => { setToken(e.target.value.replace(/\D/g, "").slice(0, 6)); if (error) setError(""); }}
                placeholder="123456"
                inputMode="numeric"
                autoComplete="one-time-code"
                className="font-mono text-lg tracking-widest"
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={() => void verify()} disabled={busy || token.length !== 6}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : "Verify & activate"}
              </Button>
            </div>
          </div>
        )}

        {step === "done" && (
          <div className="py-8 text-center space-y-3">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-emerald-500/15">
              <Check className="size-6 text-emerald-600" />
            </div>
            <div className="text-sm font-medium">2FA enabled</div>
            <p className="text-xs text-muted-foreground">
              Future logins will ask for a TOTP code from your authenticator app.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DisableDialog
// ─────────────────────────────────────────────────────────────────────────────

function DisableDialog({
  open, onOpenChange, onSuccess,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSuccess: () => void;
}) {
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setPassword("");
    setToken("");
    setError("");
  }, [open]);

  async function submit() {
    if (!password && !token) {
      setError("Enter your current password or a TOTP code.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/auth/2fa/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, token }),
      });
      const body = await r.json();
      if (!r.ok) {
        setError(body?.error || "Failed to disable 2FA.");
        return;
      }
      toast.success("2FA disabled.");
      onSuccess();
    } catch (e) {
      console.error("[2fa.disable]", e);
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Disable Two-Factor Authentication</DialogTitle>
          <DialogDescription>
            Provide your current password OR a valid TOTP code to confirm. After disabling, login will use password only.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="2fa-disable-pw">Current password</Label>
            <Input
              id="2fa-disable-pw"
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); if (error) setError(""); }}
              autoComplete="current-password"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="2fa-disable-token">OR TOTP code</Label>
            <Input
              id="2fa-disable-token"
              value={token}
              onChange={(e) => { setToken(e.target.value.replace(/\D/g, "").slice(0, 6)); if (error) setError(""); }}
              placeholder="123456"
              inputMode="numeric"
              autoComplete="one-time-code"
              className="font-mono tracking-widest"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => void submit()} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : "Disable 2FA"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Silence unused-import lints for icons that may be used in follow-up work.
void RefreshCw;
