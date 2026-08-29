"use client";

import * as React from "react";
import Image from "next/image";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ShieldCheck,
  FileText,
  Calendar,
  Hash,
  Eye,
  Loader2,
  Lock,
  Fingerprint,
  Clock,
  Building2,
} from "lucide-react";
import type { DocumentVerification } from "@/lib/supabase/types";
import { useT } from "@/lib/i18n/store";

interface VerifyClientProps {
  exists: boolean;
  documentType: string | null;
  code: string;
  cipheredRecipient?: string;
}

// Friendly labels for each document_type stored in document_verifications.
// The API route is type-agnostic — it just returns the raw document_type
// string ("offer" | "invoice" | "proforma" | "loi") — so the verify page
// renders this map's value instead of capitalising the raw string. Without
// it, "loi" would render as "Loi" rather than the more descriptive
// "Letter of Intent".
const DOC_TYPE_LABELS: Record<string, string> = {
  offer: "Offer",
  invoice: "Commercial Invoice",
  proforma: "Proforma Invoice",
  loi: "Letter of Intent",
};

function docTypeLabel(t: (k: string) => string, raw?: string | null): string {
  if (!raw) return t("misc-verify-doc-fallback");
  return DOC_TYPE_LABELS[raw] || raw.charAt(0).toUpperCase() + raw.slice(1);
}

export function VerifyClient({ exists, documentType, code, cipheredRecipient = "—" }: VerifyClientProps) {
  const t = useT();
  const [phase, setPhase] = React.useState<"requesting" | "denied" | "ready">("requesting");
  const [gpsCoords, setGpsCoords] = React.useState<{ latitude: number; longitude: number; accuracy?: number } | null>(null);
  const submittedRef = React.useRef(false);
  // CRITICAL FIX (audit P0-1/D-1): fetch the full verification payload ONLY
  // after GPS is granted. The SSR page no longer passes the full object as a
  // prop — this prevents document data from leaking in the RSC payload.
  const [v, setV] = React.useState<DocumentVerification | null>(null);

  // After GPS is granted, fetch the full verification via the API.
  React.useEffect(() => {
    if (phase !== "ready" || v) return;
    fetch(`/api/verify/${encodeURIComponent(code)}?gps=1`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data && !data.requires_gps) setV(data); })
      .catch(() => {});
  }, [phase, code, v]);

  // Request GPS — BLOCK if user denies
  React.useEffect(() => {
    if (submittedRef.current) return;

    const submit = (coords: { latitude: number; longitude: number; accuracy?: number } | null, source: "browser" | "ip") => {
      fetch(`/api/verify/${encodeURIComponent(code)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          latitude: coords?.latitude ?? null,
          longitude: coords?.longitude ?? null,
          accuracy: coords?.accuracy ?? null,
          source,
        }),
        keepalive: true,
      })
        .catch(() => {})
        .finally(() => {
          submittedRef.current = true;
          setPhase("ready");
        });
    };

    if (typeof navigator === "undefined" || !navigator.geolocation) {
      submit(null, "ip");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coords = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        };
        setGpsCoords(coords);
        submit(coords, "browser");
      },
      () => {
        // User denied — BLOCK, don't submit, don't show document
        setPhase("denied");
      },
      {
        enableHighAccuracy: true,
        timeout: 15_000,
        maximumAge: 0,
      }
    );
  }, [code]);

  // ── Phase: Requesting location ──────────────────────────────────
  if (phase === "requesting") {
    return (
      <div className="verify-bg min-h-screen flex items-center justify-center p-4">
        <div className="verify-card w-full max-w-md p-10 text-center">
          <div className="verify-glow" />
          <div className="relative z-10">
            <div className="verify-logo mb-8">
              <div className="size-12 rounded-xl overflow-hidden flex items-center justify-center mx-auto shadow-lg">
                <Image src="/logo.svg" alt="VELOS" width={48} height={48} priority />
              </div>
              <p className="text-xs tracking-[0.2em] uppercase text-slate-400 mt-2">VELOS</p>
            </div>

            <div className="relative mb-6">
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="size-24 rounded-full border-2 border-slate-200/40 animate-ping-slow" />
              </div>
              <Loader2 className="size-10 animate-spin mx-auto text-slate-600 relative z-10 mt-7" />
            </div>

            <h1 className="text-lg font-semibold text-slate-800 mb-2">{t("misc-verify-authenticating")}</h1>
            <p className="text-sm text-slate-500 leading-relaxed">
              {t("misc-verify-allow-location")}
            </p>
            <p className="text-xs text-slate-400 mt-3 leading-relaxed">
              {t("misc-verify-location-required")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── Phase: Location denied — BLOCKED ─────────────────────────────
  if (phase === "denied") {
    return (
      <div className="verify-bg min-h-screen flex items-center justify-center p-4">
        <div className="verify-card w-full max-w-md p-10 text-center">
          <div className="verify-glow verify-glow-red" />
          <div className="relative z-10">
            <div className="verify-logo mb-8">
              <div className="size-12 rounded-xl overflow-hidden flex items-center justify-center mx-auto shadow-lg">
                <Image src="/logo.svg" alt="VELOS" width={48} height={48} priority />
              </div>
              <p className="text-xs tracking-[0.2em] uppercase text-slate-400 mt-2">VELOS</p>
            </div>

            <div className="size-16 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-5">
              <Lock className="size-8 text-red-500" />
            </div>

            <h1 className="text-lg font-semibold text-slate-800 mb-2">{t("misc-verify-access-required")}</h1>
            <p className="text-sm text-slate-500 leading-relaxed mb-6">
              {t("misc-verify-cannot-verify")}
            </p>

            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-left space-y-2">
              <p className="text-xs font-semibold text-slate-700">{t("misc-verify-how-to-enable")}</p>
              <div className="text-xs text-slate-500 space-y-1.5">
                <p>📱 <strong>{t("misc-verify-ios-safari")}</strong></p>
                <p>🤖 <strong>{t("misc-verify-android-chrome")}</strong></p>
                <p>💻 <strong>{t("misc-verify-desktop")}</strong></p>
              </div>
            </div>

            <button
              onClick={() => window.location.reload()}
              className="mt-6 w-full py-2.5 rounded-xl bg-slate-800 text-white text-sm font-medium hover:bg-slate-900 transition-colors"
            >
              {t("misc-verify-reload-try-again")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Phase: Ready — but still fetching the verification payload ─────
  if (phase === "ready" && !v) {
    // If the code doesn't exist at all, show "not found".
    if (!exists) {
      return (
        <div className="verify-bg min-h-screen flex items-center justify-center p-4">
          <div className="verify-card w-full max-w-md p-10 text-center">
            <div className="verify-glow verify-glow-red" />
            <div className="relative z-10">
              <div className="verify-logo mb-8">
                <div className="size-12 rounded-xl overflow-hidden flex items-center justify-center mx-auto shadow-lg">
                  <Image src="/logo.svg" alt="VELOS" width={48} height={48} priority />
                </div>
                <p className="text-xs tracking-[0.2em] uppercase text-slate-400 mt-2">VELOS</p>
              </div>
              <div className="size-16 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-5">
                <XCircle className="size-8 text-red-500" />
              </div>
              <h1 className="text-lg font-semibold text-slate-800 mb-2">{t("misc-verify-not-found")}</h1>
              <p className="text-sm text-slate-500">{t("misc-verify-check-code")}</p>
            </div>
          </div>
        </div>
      );
    }
    // Loading — fetching the full verification payload after GPS was granted.
    return (
      <div className="verify-bg min-h-screen flex items-center justify-center p-4">
        <div className="verify-card w-full max-w-md p-10 text-center">
          <div className="verify-glow" />
          <div className="relative z-10">
            <Loader2 className="size-10 animate-spin mx-auto text-slate-600 mb-4" />
            <p className="text-sm text-slate-500">{t("misc-verify-loading")}</p>
          </div>
        </div>
      </div>
    );
  }

  // ── Phase: Ready — show document ─────────────────────────────────
  const isValid = v && v.status === "active";

  return (
    <div className="verify-bg min-h-screen flex items-center justify-center p-4">
      <div className="verify-card w-full max-w-md p-8 md:p-10">
        <div className="verify-glow" />
        <div className="relative z-10">
          {/* Brand */}
          <div className="verify-brand mb-8">
            <div className="size-11 rounded-xl bg-gradient-to-br from-slate-800 to-slate-900 flex items-center justify-center shadow-lg">
              <span className="text-white font-bold text-lg">A</span>
            </div>
            <div className="flex-1">
              <p className="font-semibold text-sm tracking-tight text-slate-800">VELOS</p>
              <p className="text-xs tracking-[0.15em] uppercase text-slate-400">{t("misc-verify-trade-platform")}</p>
            </div>
          </div>

          {!v ? (
            // Invalid code
            <div className="text-center py-6">
              <div className="size-16 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-4">
                <XCircle className="size-8 text-red-500" />
              </div>
              <h1 className="text-lg font-semibold text-slate-800 mb-2">{t("misc-verify-doc-not-found")}</h1>
              <p className="text-sm text-slate-500 max-w-xs mx-auto leading-relaxed">
                {t("misc-verify-doc-not-found-desc")}
              </p>
              <div className="mt-6 p-3 rounded-xl bg-slate-50 border border-slate-200 text-left">
                <p className="text-xs text-slate-400">{t("misc-verify-code-label")}</p>
                <p className="font-mono text-sm text-slate-700">{code}</p>
              </div>
            </div>
          ) : (
            <>
              {/* Status icon + title */}
              <div className="text-center mb-6">
                <div className={`size-16 rounded-full flex items-center justify-center mx-auto mb-4 ${
                  isValid ? "bg-emerald-50" : v.status === "revoked" ? "bg-red-50" : "bg-amber-50"
                }`}>
                  {isValid ? (
                    <CheckCircle2 className="size-8 text-emerald-500" />
                  ) : v.status === "revoked" ? (
                    <XCircle className="size-8 text-red-500" />
                  ) : (
                    <AlertTriangle className="size-8 text-amber-500" />
                  )}
                </div>
                <h1 className="text-xl font-semibold text-slate-800 mb-1">
                  {isValid ? t("misc-verify-doc-verified") : v.status === "revoked" ? t("misc-verify-doc-revoked") : t("misc-verify-doc-updated")}
                </h1>
                <p className="text-sm text-slate-500">
                  {isValid
                    ? t("misc-verify-doc-verified-desc")
                    : v.status === "revoked"
                    ? t("misc-verify-doc-revoked-desc")
                    : t("misc-verify-doc-updated-desc")}
                </p>
              </div>

              {/* Document details — forensic grid */}
              <div className="space-y-2 mb-6">
                {/* Document type */}
                <div className="verify-detail-row">
                  <div className="verify-detail-icon">
                    <FileText className="size-3.5" />
                  </div>
                  <span className="verify-detail-label">{t("misc-verify-doc-type")}</span>
                  <span className="verify-detail-value">{docTypeLabel(t, v.document_type)}</span>
                </div>

                {/* Document number */}
                {v.document_number && (
                  <div className="verify-detail-row">
                    <div className="verify-detail-icon">
                      <Hash className="size-3.5" />
                    </div>
                    <span className="verify-detail-label">{t("misc-verify-doc-number")}</span>
                    <span className="verify-detail-value font-mono">{v.document_number}</span>
                  </div>
                )}

                {/* Date issued */}
                <div className="verify-detail-row">
                  <div className="verify-detail-icon">
                    <Calendar className="size-3.5" />
                  </div>
                  <span className="verify-detail-label">{t("misc-verify-date-issued")}</span>
                  <span className="verify-detail-value">
                    {v.issued_at
                      ? new Date(v.issued_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
                      : new Date(v.created_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                  </span>
                </div>

                {/* Valid until (if available) */}
                {(v as any).valid_until && (
                  <div className="verify-detail-row">
                    <div className="verify-detail-icon">
                      <Clock className="size-3.5" />
                    </div>
                    <span className="verify-detail-label">{t("misc-verify-valid-until")}</span>
                    <span className="verify-detail-value">
                      {new Date((v as any).valid_until).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                    </span>
                  </div>
                )}

                {/* Issued to (ciphered) */}
                <div className="verify-detail-row">
                  <div className="verify-detail-icon">
                    <Building2 className="size-3.5" />
                  </div>
                  <span className="verify-detail-label">{t("misc-verify-issued-to")}</span>
                  <span className="verify-detail-value font-mono tracking-wider">{cipheredRecipient}</span>
                </div>

                {/* Verification count */}
                <div className="verify-detail-row">
                  <div className="verify-detail-icon">
                    <Eye className="size-3.5" />
                  </div>
                  <span className="verify-detail-label">{t("misc-verify-times-verified")}</span>
                  <span className="verify-detail-value tabular">{(v.verification_count ?? 0) + 1}</span>
                </div>
              </div>

              {/* Verification code */}
              <div className="p-3 rounded-xl border border-slate-200/60 bg-slate-50/50">
                <div className="flex items-center gap-2 mb-1">
                  <Fingerprint className="size-3 text-slate-400" />
                  <p className="text-xs tracking-wider uppercase text-slate-400">{t("misc-verify-hash-label")}</p>
                </div>
                <p className="font-mono text-xs text-slate-600 break-all">{v.verification_code}</p>
              </div>

              {/* Security footer */}
              <div className="mt-6 flex items-start gap-2 p-3 rounded-xl bg-emerald-50/50 border border-emerald-100">
                <ShieldCheck className="size-3.5 text-emerald-500 shrink-0 mt-0.5" />
                <p className="text-xs text-slate-500 leading-relaxed">
                  {t("misc-verify-protected-desc")}
                </p>
              </div>
            </>
          )}

          {/* Footer */}
          <div className="mt-8 pt-6 border-t border-slate-200/60 text-center">
            <p className="text-xs text-slate-400">
              {t("misc-verify-copyright").replace("{year}", String(new Date().getFullYear()))}
            </p>
          </div>
        </div>
      </div>

      {/* Embedded styles — standalone page, no external CSS */}
    </div>
  );
}
