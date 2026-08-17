"use client";

import * as React from "react";
import { Building2, CheckCircle2, XCircle, Loader2, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n/store";

interface IbanInputProps {
  value: string;
  onChange: (value: string) => void;
  onBankInfo?: (info: {
    valid: boolean;
    bankName: string;
    swift: string;
    bic: string;
    country: string;
    sepa: boolean;
    formatted: string;
  }) => void;
  label?: string;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  /** When provided, shows which documents are required for this entity type */
  entityType?: string;
}

/**
 * IBAN input with live validation + automatic bank name + SWIFT/BIC lookup.
 *
 * As the user types, it calls /api/banking/validate-iban to validate the
 * IBAN checksum and look up the bank in the curated database. When a match
 * is found, it displays:
 *   - ✅ Valid IBAN badge (green) or ❌ Invalid (red)
 *   - Bank name (auto-filled)
 *   - Suggested SWIFT/BIC (auto-filled)
 *   - SEPA badge if the bank is in the SEPA scheme
 *
 * The parent component receives the bank info via onBankInfo callback so it
 * can auto-fill the bank_name, bank_swift fields in the form.
 */
export function IbanInput({
  value,
  onChange,
  onBankInfo,
  label = "IBAN",
  placeholder = "RS35 2600 0560 1001 6112 39",
  className,
  disabled,
  entityType,
}: IbanInputProps) {
  const t = useT();
  const [status, setStatus] = React.useState<"idle" | "checking" | "valid" | "invalid">("idle");
  const [bankName, setBankName] = React.useState("");
  const [swift, setSwift] = React.useState("");
  const [sepa, setSepa] = React.useState(false);
  const [country, setCountry] = React.useState("");
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the latest onBankInfo callback in a ref so the validation effect's
  // timeout closure always calls the freshest handler. The effect itself only
  // re-runs on `value` changes, but parents typically pass an inline arrow
  // (new identity every render) — without the ref we'd capture the first
  // closure and never see updates (stale-closure bug, P1-3).
  const onBankInfoRef = React.useRef(onBankInfo);
  onBankInfoRef.current = onBankInfo;

  // Validate IBAN on change (debounced)
  React.useEffect(() => {
    const clean = value.replace(/\s/g, "");
    if (clean.length < 15) {
      setStatus("idle");
      setBankName("");
      setSwift("");
      setSepa(false);
      setCountry("");
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setStatus("checking");
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await fetch("/api/banking/validate-iban", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ iban: clean, entity_type: entityType }),
        });
        const data = await r.json();
        setStatus(data.valid ? "valid" : "invalid");
        setBankName(data.bankName || "");
        setSwift(data.swift || "");
        setSepa(data.sepa || false);
        setCountry(data.country || "");
        const cb = onBankInfoRef.current;
        if (cb) {
          cb({
            valid: data.valid,
            bankName: data.bankName || "",
            swift: data.swift || "",
            bic: data.swift || "",
            country: data.country || "",
            sepa: data.sepa || false,
            formatted: data.formatted || clean,
          });
        }
      } catch {
        setStatus("idle");
      }
    }, 500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value]);

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <Label className="flex items-center gap-1.5">
          <Building2 className="size-3.5" />
          {label}
        </Label>
        <div className="relative">
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value.toUpperCase())}
            placeholder={placeholder}
            disabled={disabled}
            className={cn(
              "pr-10 font-mono uppercase",
              status === "valid" && "border-emerald-500/50 focus-visible:ring-emerald-500/30",
              status === "invalid" && "border-destructive/50 focus-visible:ring-destructive/30",
              className
            )}
          />
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            {status === "checking" && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            {status === "valid" && <CheckCircle2 className="size-4 text-emerald-600" />}
            {status === "invalid" && <XCircle className="size-4 text-destructive" />}
          </div>
        </div>
      </div>

      {/* Bank info display */}
      {status === "valid" && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-50/50 dark:bg-emerald-950/20 p-3 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className="bg-emerald-500/10 text-emerald-700 border-emerald-500/30">
              <CheckCircle2 className="size-3 mr-1" /> {t("misc-iban-valid")}
            </Badge>
            {country && <Badge variant="secondary">{country}</Badge>}
            {sepa && (
              <Badge variant="outline" className="bg-blue-500/10 text-blue-700 border-blue-500/30">
                SEPA
              </Badge>
            )}
          </div>
          {bankName && (
            <div className="text-sm">
              <span className="text-muted-foreground">{t("misc-iban-bank-label")}</span>
              <span className="font-medium">{bankName}</span>
            </div>
          )}
          {swift && (
            <div className="text-sm">
              <span className="text-muted-foreground">{t("misc-iban-swift-label")}</span>
              <span className="font-mono font-medium">{swift}</span>
            </div>
          )}
          {!bankName && (
            <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Info className="size-3.5 shrink-0 mt-0.5" />
              <span>{t("misc-iban-bank-not-found")}</span>
            </div>
          )}
        </div>
      )}

      {status === "invalid" && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
          <div className="flex items-center gap-2">
            <XCircle className="size-4 text-destructive" />
            <span className="text-sm font-medium text-destructive">{t("misc-iban-invalid")}</span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {t("misc-iban-check-msg")}
          </p>
        </div>
      )}

      {entityType && (
        <div className="text-xs text-muted-foreground">
          {entityType === "individual" ? (
            <span>👤 {t("misc-iban-personal")}</span>
          ) : (
            <span>🏢 {t("misc-iban-corporate")}</span>
          )}
        </div>
      )}
    </div>
  );
}
