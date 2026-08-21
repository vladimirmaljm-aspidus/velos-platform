"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  Plus,
  Award,
  CheckCircle2,
  Clock,
  Trash2,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { useT } from "@/lib/i18n/store";
import { fmtDate } from "@/lib/utils/format";
import type {
  CertType,
  SustainabilityCert,
} from "@/lib/supabase/marketplace-esg-types";
import { CERT_TYPE_LABEL_KEY } from "@/lib/supabase/marketplace-esg-types";

interface ListResponse {
  items: SustainabilityCert[];
}

const CERT_TYPES: CertType[] = [
  "fsc", "rspo", "msc", "iso14001", "iso45001", "iso50001",
  "sa8000", "fairtrade", "organic", "global_gap",
  "rainforest_alliance", "carbon_neutral", "b_corp",
];

/**
 * SustainabilityCerts — the list of a company's sustainability
 * certifications, shown on the company profile.
 *
 * Each cert row surfaces:
 *   • cert type (label + icon — same mapping as the ESG rating uses)
 *   • cert number + issuer (if supplied)
 *   • valid-from → valid-until range (or "—" when not supplied)
 *   • verification status (verified ✓ / pending)
 *   • document link (when supplied)
 *
 * The component takes two flags so the same code path serves both the
 * self-profile (the company viewing its own page) and the public view:
 *   • `canEdit` — when true, an "Add Certification" button is shown and
 *     the company can delete its own (unverified) certs.
 *   • `canVerify` — when true (super-admin only), a "Verify" button is
 *     shown next to each unverified cert.
 *
 * Verification is a single-click super-admin action — clicking "Verify"
 * fires a PUT /api/marketplace/esg/certs/[id] with `{ verified: true }`.
 */
export function SustainabilityCerts({
  partnerId,
  canEdit = false,
  canVerify = false,
}: {
  partnerId: string;
  canEdit?: boolean;
  canVerify?: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);

  const q = useQuery<ListResponse>({
    queryKey: ["marketplace-esg-certs", partnerId],
    queryFn: async () => {
      const r = await fetch(`/api/marketplace/esg/certs?partnerId=${encodeURIComponent(partnerId)}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    staleTime: 30_000,
  });

  // Verify mutation — super-admin only path.
  const verifyMut = useMutation({
    mutationFn: async (certId: string) => {
      const r = await fetch(`/api/marketplace/esg/certs/${certId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verified: true }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({ error: "Failed." }));
        throw new Error(e?.error || "Failed.");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("marketplace-esg-cert-verified"));
      qc.invalidateQueries({ queryKey: ["marketplace-esg-certs", partnerId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Delete mutation — owning partner only.
  const deleteMut = useMutation({
    mutationFn: async (certId: string) => {
      const r = await fetch(`/api/marketplace/esg/certs/${certId}`, { method: "DELETE" });
      if (!r.ok) {
        const e = await r.json().catch(() => ({ error: "Failed." }));
        throw new Error(e?.error || "Failed.");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("marketplace-esg-cert-deleted"));
      qc.invalidateQueries({ queryKey: ["marketplace-esg-certs", partnerId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const items = q.data?.items ?? [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Award className="h-4 w-4" />
            {t("marketplace-esg-certs-title")}
            {items.length > 0 && (
              <Badge variant="outline" className="text-xs ml-1">{items.length}</Badge>
            )}
          </CardTitle>
          {canEdit && (
            <Button size="sm" onClick={() => setShowAdd(true)}>
              <Plus className="h-4 w-4 mr-1" />
              {t("marketplace-esg-certs-add")}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {q.isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : q.isError ? (
          <p className="text-sm text-rose-600">{t("marketplace-esg-certs-load-error")}</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("marketplace-esg-certs-empty")}</p>
        ) : (
          <ul className="space-y-2">
            {items.map((c) => (
              <CertRow
                key={c.id}
                cert={c}
                canVerify={canVerify}
                canDelete={canEdit}
                onVerify={() => verifyMut.mutate(c.id)}
                onDelete={() => deleteMut.mutate(c.id)}
                verifying={verifyMut.isPending && verifyMut.variables === c.id}
                deleting={deleteMut.isPending && deleteMut.variables === c.id}
              />
            ))}
          </ul>
        )}
      </CardContent>

      {showAdd && canEdit && (
        <AddCertDialog
          partnerId={partnerId}
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false);
            qc.invalidateQueries({ queryKey: ["marketplace-esg-certs", partnerId] });
          }}
        />
      )}
    </Card>
  );
}

// ─── Cert row ──────────────────────────────────────────────────────────────

function CertRow({
  cert,
  canVerify,
  canDelete,
  onVerify,
  onDelete,
  verifying,
  deleting,
}: {
  cert: SustainabilityCert;
  canVerify: boolean;
  canDelete: boolean;
  onVerify: () => void;
  onDelete: () => void;
  verifying: boolean;
  deleting: boolean;
}) {
  const t = useT();
  const labelKey = CERT_TYPE_LABEL_KEY[cert.cert_type as CertType] ?? "marketplace-esg-cert-unknown";

  return (
    <li className="rounded-md border p-3 space-y-2">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="flex items-start gap-2 min-w-0">
          <div className="size-8 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{t(labelKey)}</p>
            <p className="text-xs text-muted-foreground">
              {cert.cert_issuer || t("marketplace-esg-certs-issuer-na")}
              {cert.cert_number && (
                <span className="ml-1.5 font-mono">· {cert.cert_number}</span>
              )}
            </p>
          </div>
        </div>
        {cert.verified ? (
          <Badge variant="outline" className="border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 text-xs">
            <CheckCircle2 className="h-3 w-3 mr-1" />
            {t("marketplace-esg-certs-verified")}
          </Badge>
        ) : (
          <Badge variant="outline" className="border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400 text-xs">
            <Clock className="h-3 w-3 mr-1" />
            {t("marketplace-esg-certs-pending")}
          </Badge>
        )}
      </div>

      <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
        <span className="flex items-center gap-1">
          {t("marketplace-esg-certs-valid-from")}:{" "}
          <span className="font-medium text-foreground">{fmtDate(cert.valid_from)}</span>
        </span>
        <span>→</span>
        <span className="flex items-center gap-1">
          {t("marketplace-esg-certs-valid-until")}:{" "}
          <span className="font-medium text-foreground">{fmtDate(cert.valid_until)}</span>
        </span>
        {cert.document_url && (
          <a
            href={cert.document_url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-primary hover:underline"
          >
            {t("marketplace-esg-certs-document")}
          </a>
        )}
      </div>

      {(canVerify || canDelete) && (
        <div className="flex items-center gap-2 pt-1 border-t">
          {canVerify && !cert.verified && (
            <Button size="sm" variant="outline" onClick={onVerify} disabled={verifying}>
              {verifying ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5 mr-1" />}
              {t("marketplace-esg-certs-verify")}
            </Button>
          )}
          {canDelete && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onDelete}
              disabled={deleting}
              className="text-rose-600 hover:text-rose-700"
            >
              {deleting ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Trash2 className="h-3.5 w-3.5 mr-1" />}
              {t("marketplace-esg-certs-delete")}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

// ─── Add cert dialog ───────────────────────────────────────────────────────

function AddCertDialog({
  partnerId: _partnerId,
  onClose,
  onCreated,
}: {
  partnerId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const t = useT();
  const [form, setForm] = useState<{
    cert_type: CertType;
    cert_number: string;
    cert_issuer: string;
    valid_from: string;
    valid_until: string;
    document_url: string;
  }>({
    cert_type: "iso14001",
    cert_number: "",
    cert_issuer: "",
    valid_from: "",
    valid_until: "",
    document_url: "",
  });

  const createMut = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/marketplace/esg/certs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cert_type: form.cert_type,
          cert_number: form.cert_number || null,
          cert_issuer: form.cert_issuer || null,
          valid_from: form.valid_from || null,
          valid_until: form.valid_until || null,
          document_url: form.document_url || null,
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({ error: "Failed." }));
        throw new Error(e?.error || "Failed.");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("marketplace-esg-cert-added"));
      onCreated();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const setField = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="w-[95vw] sm:max-w-2xl max-h-[88vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle>{t("marketplace-esg-certs-add-title")}</DialogTitle>
          <DialogDescription>{t("marketplace-esg-certs-add-desc")}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-3">
          <div>
            <Label htmlFor="ec-type">{t("marketplace-esg-certs-type-label")}</Label>
            <Select
              value={form.cert_type}
              onValueChange={(v) => setField("cert_type", v as CertType)}
            >
              <SelectTrigger id="ec-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CERT_TYPES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {t(CERT_TYPE_LABEL_KEY[c])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ec-num">{t("marketplace-esg-certs-number-label")}</Label>
              <Input
                id="ec-num"
                value={form.cert_number}
                onChange={(e) => setField("cert_number", e.target.value)}
                maxLength={200}
              />
            </div>
            <div>
              <Label htmlFor="ec-issuer">{t("marketplace-esg-certs-issuer-label")}</Label>
              <Input
                id="ec-issuer"
                value={form.cert_issuer}
                onChange={(e) => setField("cert_issuer", e.target.value)}
                maxLength={200}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ec-from">{t("marketplace-esg-certs-valid-from")}</Label>
              <Input
                id="ec-from"
                type="date"
                value={form.valid_from.slice(0, 10)}
                onChange={(e) => setField("valid_from", e.target.value ? new Date(e.target.value).toISOString() : "")}
              />
            </div>
            <div>
              <Label htmlFor="ec-until">{t("marketplace-esg-certs-valid-until")}</Label>
              <Input
                id="ec-until"
                type="date"
                value={form.valid_until.slice(0, 10)}
                onChange={(e) => setField("valid_until", e.target.value ? new Date(e.target.value).toISOString() : "")}
              />
            </div>
          </div>

          <div>
            <Label htmlFor="ec-doc">{t("marketplace-esg-certs-document-label")}</Label>
            <Input
              id="ec-doc"
              type="url"
              placeholder="https://…"
              value={form.document_url}
              onChange={(e) => setField("document_url", e.target.value)}
              maxLength={1000}
            />
          </div>

          <p className="text-xs text-muted-foreground">
            {t("marketplace-esg-certs-add-hint")}
          </p>
        </div>

        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={onClose}>{t("portal-action-cancel")}</Button>
          <Button onClick={() => createMut.mutate()} disabled={createMut.isPending}>
            {createMut.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            {t("marketplace-esg-certs-add-save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
