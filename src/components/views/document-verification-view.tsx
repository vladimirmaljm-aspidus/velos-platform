"use client";

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  ShieldCheck, ShieldAlert, ShieldX, QrCode, ScanLine, FileSearch, Search,
  CheckCircle2, XCircle, Fingerprint, Upload, FileWarning, Hash, Loader2,
  ClipboardCopy, Calendar, Activity, Globe, FileText,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { ModuleInfoTooltip } from "@/components/common/module-info-tooltip";

import { EmptyState } from "@/components/common/empty-state";
import { fmtDate, fmtDateTime, fmtBytes, fmtRelative } from "@/lib/utils/format";
import { DocumentVerification, Offer, Invoice, Proforma } from "@/lib/supabase/types";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useT } from "@/lib/i18n/store";

type DocType = "offer" | "invoice" | "proforma";

const DOC_TYPE_LABEL_KEYS: Record<DocType, string> = {
  offer: "admin-verify-doc-type-offer", invoice: "admin-verify-doc-type-invoice", proforma: "admin-verify-doc-type-proforma",
};

const STATUS_LABEL_KEYS: Record<DocumentVerification["status"], string> = {
  active: "admin-verify-status-active", revoked: "admin-verify-status-revoked", superseded: "admin-verify-status-superseded",
};

const STATUS_BADGE: Record<DocumentVerification["status"], string> = {
  active: "bg-chart-1/15 text-chart-1 border-chart-1/30",
  revoked: "bg-destructive/10 text-destructive border-destructive/30",
  superseded: "bg-chart-3/15 text-chart-3 border-chart-3/30",
};

// ============================================================
// Main view
// ============================================================
export function DocumentVerificationView() {
  const [tab, setTab] = useState("by-code");
  const t = useT();

  return (
    <div>
      <PageHeader
        title={t("admin-verify-title")}
        description={t("admin-verify-desc")}
      />
      <ModuleInfoTooltip
        title="Document Verification"
        description="Verify the authenticity of uploaded documents. AI-powered analysis of certificates and trade documents."
        howToUse={["Upload a document for verification", "AI analyzes the document content", "Review the verification result", "Mark as verified or flagged"]}
      />

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabsList className="flex w-full max-w-md overflow-x-auto justify-start sm:grid sm:grid-cols-3">
          <TabsTrigger value="by-code" className="text-xs sm:text-sm">
            <ScanLine className="size-3.5 mr-1.5" /> {t("admin-verify-tab-by-code")}
          </TabsTrigger>
          <TabsTrigger value="by-doc" className="text-xs sm:text-sm">
            <FileSearch className="size-3.5 mr-1.5" /> {t("admin-verify-tab-by-doc")}
          </TabsTrigger>
          <TabsTrigger value="forensic" className="text-xs sm:text-sm">
            <Fingerprint className="size-3.5 mr-1.5" /> {t("admin-verify-tab-forensic")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="by-code">
          <VerifyByCodeTab />
        </TabsContent>

        <TabsContent value="by-doc">
          <VerifyByDocTab />
        </TabsContent>

        <TabsContent value="forensic">
          <ForensicTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ============================================================
// Tab 1: Verify by code
// ============================================================
interface VerifyResult {
  valid: boolean;
  result: "valid" | "invalid" | "revoked" | "superseded" | "modified";
  message: string;
  document_type?: DocType;
  document_number?: string;
  issued_at?: string;
  verification_count?: number;
  last_verified_at?: string;
}

function VerifyByCodeTab() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [code, setCode] = useState("");
  const [submittedCode, setSubmittedCode] = useState<string | null>(null);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["verify-code", tenantKey, submittedCode],
    queryFn: async () => {
      const r = await fetch(api(`/api/verify/${submittedCode}`));
      const json = await r.json();
      if (!r.ok && !json.result) throw new Error("Verification failed");
      return json as VerifyResult;
    },
    enabled: !!submittedCode,
  });

  function handleVerify() {
    const trimmed = code.trim();
    if (!trimmed) {
      toast.error(t("admin-verify-enter-code"));
      return;
    }
    setSubmittedCode(trimmed);
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Input panel */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ScanLine className="size-4 text-primary" /> {t("admin-verify-code-lookup")}
          </CardTitle>
          <CardDescription className="text-xs">
            {t("admin-verify-code-lookup-desc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="code" className="text-xs">{t("admin-verify-code-label")}</Label>
            <Input
              id="code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleVerify()}
              placeholder={t("admin-verify-code-placeholder")}
              className="font-mono"
              autoCapitalize="characters"
            />
            <p className="text-xs text-muted-foreground">
              {t("admin-verify-code-hint")}
            </p>
          </div>
          <Button onClick={handleVerify} disabled={isLoading || isFetching} className="w-full">
            {(isLoading || isFetching) ? (
              <Loader2 className="size-4 mr-1 animate-spin" />
            ) : (
              <Search className="size-4 mr-1" />
            )}
            {t("admin-verify-verify-btn")}
          </Button>
        </CardContent>
      </Card>

      {/* Result panel */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("admin-verify-result-title")}</CardTitle>
          <CardDescription className="text-xs">
            {submittedCode ? `${t("admin-verify-result-code-prefix")} ${submittedCode}` : t("admin-verify-result-awaiting")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!submittedCode ? (
            <EmptyState
              icon={<ShieldCheck className="size-6" />}
              title={t("admin-verify-empty-title")}
              description={t("admin-verify-empty-desc")}
            />
          ) : isLoading || isFetching ? (
            <div className="space-y-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : data ? (
            <VerifyResultView result={data} />
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function VerifyResultView({ result }: { result: VerifyResult }) {
  const t = useT();
  if (result.valid) {
    return (
      <div className="space-y-4">
        <Alert className="border-chart-1/30 bg-chart-1/5">
          <CheckCircle2 className="size-4 text-chart-1" />
          <AlertTitle className="text-chart-1">{t("admin-verify-authentic")}</AlertTitle>
          <AlertDescription className="text-sm">
            {result.message}
          </AlertDescription>
        </Alert>

        <div className="grid grid-cols-2 gap-3">
          <DetailField icon={FileText} label={t("admin-verify-doc-type-label")} value={result.document_type ? t(DOC_TYPE_LABEL_KEYS[result.document_type as DocType]) : "—"} />
          <DetailField icon={Hash} label={t("admin-verify-doc-number-label")} value={result.document_number || "—"} mono />
          <DetailField icon={Calendar} label={t("admin-verify-issued-at")} value={result.issued_at ? fmtDateTime(result.issued_at) : "—"} />
          <DetailField icon={Activity} label={t("admin-verify-verification-count")} value={String(result.verification_count ?? "—")} mono />
        </div>

        {result.last_verified_at && (
          <div className="text-xs text-muted-foreground flex items-center gap-2">
            <Globe className="size-3.5" />
            {t("admin-verify-last-verified")} <span className="tabular">{fmtRelative(result.last_verified_at)}</span>
          </div>
        )}
      </div>
    );
  }

  // Invalid / revoked / superseded
  return (
    <div className="space-y-4">
      <Alert variant={result.result === "revoked" || result.result === "superseded" ? "default" : "destructive"}
        className={result.result === "invalid" ? "" : "border-chart-3/30 bg-chart-3/5"}>
        <ShieldX className="size-4" />
        <AlertTitle>
          {result.result === "invalid" ? t("admin-verify-invalid-code")
            : result.result === "revoked" ? t("admin-verify-doc-revoked")
            : result.result === "superseded" ? t("admin-verify-doc-superseded")
            : t("admin-verify-failed")}
        </AlertTitle>
        <AlertDescription className="text-sm">{result.message}</AlertDescription>
      </Alert>

      {result.document_number && (
        <div className="grid grid-cols-2 gap-3">
          <DetailField icon={FileText} label={t("admin-verify-doc-type-label")} value={result.document_type ? t(DOC_TYPE_LABEL_KEYS[result.document_type as DocType]) : "—"} />
          <DetailField icon={Hash} label={t("admin-verify-doc-number-label")} value={result.document_number} mono />
          {result.issued_at && <DetailField icon={Calendar} label={t("admin-verify-issued-at")} value={fmtDateTime(result.issued_at)} />}
        </div>
      )}
    </div>
  );
}

function DetailField({ icon: Icon, label, value, mono }: { icon: any; label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card p-3">
      <div className="text-xs text-muted-foreground uppercase tracking-wide flex items-center gap-1 mb-1">
        <Icon className="size-3" /> {label}
      </div>
      <div className={`text-sm font-medium truncate ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}

// ============================================================
// Tab 2: Verify by document
// ============================================================
function VerifyByDocTab() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [docType, setDocType] = useState<DocType>("offer");
  const [docId, setDocId] = useState<string>("");

  // Fetch document list based on type
  const docsQuery = useQuery({
    queryKey: ["docs-for-verify", tenantKey, docType],
    queryFn: async () => {
      const endpoint = docType === "offer" ? api("/api/offers") : docType === "invoice" ? api("/api/invoices") : api("/api/proformas");
      const r = await fetch(endpoint);
      if (!r.ok) throw new Error("Failed to load documents");
      const data = await r.json();
      return (data.items || []) as Array<Offer | Invoice | Proforma>;
    },
  });

  const verQuery = useQuery({
    queryKey: ["doc-verify-by-doc", tenantKey, docType, docId],
    queryFn: async () => {
      const r = await fetch(api(`/api/document-verify/by-doc?doc_type=${docType}&doc_id=${docId}`));
      if (!r.ok) throw new Error("Lookup failed");
      const data = await r.json();
      return data as { verification: DocumentVerification | null };
    },
    enabled: !!docId,
  });

  const docs = docsQuery.data || [];
  const verification = verQuery.data?.verification || null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Selection */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <FileSearch className="size-4 text-primary" /> {t("admin-verify-doc-lookup")}
          </CardTitle>
          <CardDescription className="text-xs">
            {t("admin-verify-doc-lookup-desc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">{t("admin-verify-doc-type-label")}</Label>
            <Select value={docType} onValueChange={(v) => { setDocType(v as DocType); setDocId(""); }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="offer">{t("admin-verify-doc-type-offer")}</SelectItem>
                <SelectItem value="invoice">{t("admin-verify-doc-type-invoice")}</SelectItem>
                <SelectItem value="proforma">{t("admin-verify-doc-type-proforma")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">{t("admin-verify-doc-label")}</Label>
            {docsQuery.isLoading ? (
              <Skeleton className="h-9 w-full" />
            ) : docs.length === 0 ? (
              <div className="text-xs text-muted-foreground py-2">{t("admin-verify-no-docs").replace("{type}", t(DOC_TYPE_LABEL_KEYS[docType]).toLowerCase())}</div>
            ) : (
              <Select value={docId} onValueChange={setDocId}>
                <SelectTrigger><SelectValue placeholder={t("admin-verify-select-doc-placeholder")} /></SelectTrigger>
                <SelectContent>
                  {docs.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      <span className="font-mono">{d.number}</span> · {d.subject}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Verification record */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("admin-verify-record-title")}</CardTitle>
          <CardDescription className="text-xs">
            {!docId ? t("admin-verify-record-select-desc") : verQuery.isLoading ? t("admin-verify-record-loading") : verification ? t("admin-verify-record-meta-desc") : t("admin-verify-record-empty-desc")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!docId ? (
            <EmptyState
              icon={<QrCode className="size-6" />}
              title={t("admin-verify-nothing-selected-title")}
              description={t("admin-verify-nothing-selected-desc")}
            />
          ) : verQuery.isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : !verification ? (
            <EmptyState
              icon={<ShieldAlert className="size-6" />}
              title={t("admin-verify-no-verification-title")}
              description={t("admin-verify-no-verification-desc")}
            />
          ) : (
            <VerificationRecordView v={verification} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function VerificationRecordView({ v }: { v: DocumentVerification }) {
  const t = useT();
  const code = v.verification_code;
  return (
    <div className="space-y-4">
      {/* QR placeholder */}
      <div className="flex flex-col sm:flex-row items-center gap-4">
        <div className="size-32 shrink-0 rounded-xl border-2 border-foreground/80 bg-card flex items-center justify-center p-3 relative">
          <div className="absolute inset-2 grid grid-cols-7 grid-rows-7 gap-0.5">
            {Array.from({ length: 49 }).map((_, i) => {
              const row = Math.floor(i / 7);
              const col = i % 7;
              // pseudo-random pattern from code hash (deterministic)
              const filled = (code.charCodeAt((row * 7 + col) % code.length) + row + col) % 3 !== 0;
              const corner = (row < 2 && col < 2) || (row < 2 && col > 4) || (row > 4 && col < 2);
              return (
                <div
                  key={i}
                  className={filled || corner ? "bg-foreground" : "bg-transparent"}
                />
              );
            })}
          </div>
        </div>
        <div className="flex-1 min-w-0 text-center sm:text-left">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">{t("admin-verify-code-label")}</div>
          <div className="font-mono text-sm font-semibold break-all bg-muted/40 rounded-md p-2 border border-border/60">
            {code}
          </div>
          <div className="text-xs text-muted-foreground mt-2 flex items-center justify-center sm:justify-start gap-1.5">
            <ScanLine className="size-3" /> {t("admin-verify-scan-hint")}
          </div>
        </div>
      </div>

      <Separator />

      <div className="grid grid-cols-2 gap-3">
        <DetailField icon={FileText} label={t("admin-verify-doc-type-label")} value={t(DOC_TYPE_LABEL_KEYS[v.document_type])} />
        <DetailField icon={Hash} label={t("admin-verify-doc-number-label")} value={v.document_number} mono />
        <DetailField icon={Calendar} label={t("admin-verify-issued-at")} value={fmtDateTime(v.issued_at)} />
        <DetailField icon={Activity} label={t("admin-verify-verification-count")} value={String(v.verification_count)} mono />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">{t("admin-verify-stored-hash")}</Label>
        <div className="font-mono text-xs break-all bg-muted/40 rounded-md p-2 border border-border/60">
          {v.pdf_hash}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={STATUS_BADGE[v.status]}>
            {t(STATUS_LABEL_KEYS[v.status])}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {t("admin-verify-pdf-size")} <span className="tabular">{fmtBytes(v.pdf_size)}</span>
          </span>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            // AUDIT19 (frontend #9) — await + catch (parity with
            // api-keys-view): no false "copied" toast on clipboard failure.
            try {
              await navigator.clipboard?.writeText(code);
              toast.success(t("admin-verify-code-copied"));
            } catch {
              toast.error(`Copy failed — copy manually: ${code}`);
            }
          }}
        >
          <ClipboardCopy className="size-3.5 mr-1" /> {t("admin-verify-copy-code")}
        </Button>
      </div>
    </div>
  );
}

// ============================================================
// Tab 3: Forensic check
// ============================================================
interface ForensicResult {
  match: boolean;
  result: "valid" | "modified" | "invalid";
  message: string;
  document_number?: string;
  document_type?: DocType;
  issued_at?: string;
  stored_hash?: string;
  computed_hash?: string;
  pdf_size?: number;
}

function ForensicTab() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [code, setCode] = useState("");
  const [hash, setHash] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [computing, setComputing] = useState(false);
  const [result, setResult] = useState<ForensicResult | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleFile(file: File) {
    setFileName(file.name);
    setComputing(true);
    setHash("");
    try {
      const buffer = await file.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", buffer);
      const hex = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      setHash(`sha256:${hex}`);
      toast.success(t("admin-verify-toast-hashed").replace("{name}", file.name));
    } catch {
      toast.error(t("admin-verify-toast-hash-failed"));
    } finally {
      setComputing(false);
    }
  }

  async function handleCheck() {
    if (!code.trim()) {
      toast.error(t("admin-verify-toast-code-required"));
      return;
    }
    if (!hash.trim()) {
      toast.error(t("admin-verify-toast-hash-required"));
      return;
    }
    setSubmitting(true);
    setResult(null);
    try {
      const r = await fetch(api("/api/document-verify/forensic"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          verification_code: code.trim(),
          pdf_hash: hash.trim().startsWith("sha256:") ? hash.trim() : `sha256:${hash.trim()}`,
        }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || t("admin-verify-toast-forensic-failed"));
      setResult(json as ForensicResult);
      if (json.match) toast.success(t("admin-verify-toast-pdf-authentic"));
      else toast.error(t("admin-verify-toast-pdf-modified"));
    } catch (e: any) {
      toast.error(e.message || t("admin-verify-toast-forensic-failed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Input */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Fingerprint className="size-4 text-primary" /> {t("admin-verify-forensic-title")}
          </CardTitle>
          <CardDescription className="text-xs">
            {t("admin-verify-forensic-desc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="fcode" className="text-xs">{t("admin-verify-code-label")}</Label>
            <Input
              id="fcode"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="ASP-OF-2026-0014-AB12"
              className="font-mono"
              autoCapitalize="characters"
            />
          </div>

          <Separator />

          <div className="space-y-2">
            <Label className="text-xs flex items-center gap-1.5">
              <Upload className="size-3.5" /> {t("admin-verify-upload-pdf")}
            </Label>
            <label className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border/60 px-4 py-6 cursor-pointer hover:border-primary/40 hover:bg-muted/40 transition-colors">
              <input
                type="file"
                accept="application/pdf"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                }}
              />
              <Upload className="size-5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">
                {fileName ? (
                  <>{t("admin-verify-selected")} <span className="font-medium text-foreground">{fileName}</span></>
                ) : (
                  t("admin-verify-click-choose")
                )}
              </span>
            </label>
            {computing && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> {t("admin-verify-computing")}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="fhash" className="text-xs flex items-center gap-1.5">
              <Hash className="size-3.5" /> {t("admin-verify-paste-hash")}
            </Label>
            <Textarea
              id="fhash"
              value={hash}
              onChange={(e) => setHash(e.target.value)}
              rows={3}
              placeholder="sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4…"
              className="font-mono text-xs"
            />
          </div>

          <Button onClick={handleCheck} disabled={submitting || computing} className="w-full">
            {submitting ? <Loader2 className="size-4 mr-1 animate-spin" /> : <Fingerprint className="size-4 mr-1" />}
            {t("admin-verify-run-forensic")}
          </Button>
        </CardContent>
      </Card>

      {/* Result */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("admin-verify-comparison-result")}</CardTitle>
          <CardDescription className="text-xs">
            {!result ? t("admin-verify-awaiting-forensic") : result.match ? t("admin-verify-pdf-authentic") : t("admin-verify-pdf-differs")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!result ? (
            <EmptyState
              icon={<Fingerprint className="size-6" />}
              title={t("admin-verify-no-check-title")}
              description={t("admin-verify-no-check-desc")}
            />
          ) : (
            <ForensicResultView result={result} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ForensicResultView({ result }: { result: ForensicResult }) {
  const t = useT();
  if (result.result === "invalid") {
    return (
      <Alert variant="destructive">
        <ShieldX className="size-4" />
        <AlertTitle>{t("admin-verify-code-not-found")}</AlertTitle>
        <AlertDescription className="text-sm">{result.message}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <Alert
        variant={result.match ? "default" : "destructive"}
        className={result.match ? "border-chart-1/30 bg-chart-1/5" : ""}
      >
        {result.match ? <CheckCircle2 className="size-4 text-chart-1" /> : <FileWarning className="size-4" />}
        <AlertTitle className={result.match ? "text-chart-1" : ""}>
          {result.match ? t("admin-verify-authentic-no-mod") : t("admin-verify-modified")}
        </AlertTitle>
        <AlertDescription className="text-sm">{result.message}</AlertDescription>
      </Alert>

      {result.document_number && (
        <div className="grid grid-cols-2 gap-3">
          <DetailField icon={FileText} label={t("admin-verify-doc-type-label")} value={result.document_type ? t(DOC_TYPE_LABEL_KEYS[result.document_type]) : "—"} />
          <DetailField icon={Hash} label={t("admin-verify-doc-number-label")} value={result.document_number} mono />
          {result.issued_at && <DetailField icon={Calendar} label={t("admin-verify-issued-at")} value={fmtDateTime(result.issued_at)} />}
          {result.pdf_size != null && <DetailField icon={Activity} label={t("admin-verify-original-size")} value={fmtBytes(result.pdf_size)} mono />}
        </div>
      )}

      {result.stored_hash && result.computed_hash && (
        <div className="space-y-3">
          <HashRow label={t("admin-verify-stored-hash-original")} value={result.stored_hash} match={result.match} />
          <HashRow label={t("admin-verify-computed-hash")} value={result.computed_hash} match={result.match} />
          <div className={`text-xs flex items-center gap-2 ${result.match ? "text-chart-1" : "text-destructive"}`}>
            {result.match ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
            <span className="font-medium">
              {result.match ? t("admin-verify-hashes-match") : t("admin-verify-hashes-differ")}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function HashRow({ label, value, match }: { label: string; value: string; match: boolean }) {
  const t = useT();
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        {match ? (
          <Badge variant="outline" className="text-xs bg-chart-1/10 text-chart-1 border-chart-1/30">{t("admin-verify-match")}</Badge>
        ) : (
          <Badge variant="outline" className="text-xs bg-destructive/10 text-destructive border-destructive/30">{t("admin-verify-differ")}</Badge>
        )}
      </div>
      <div className="font-mono text-xs break-all bg-muted/40 rounded-md p-2 border border-border/60">
        {value}
      </div>
    </div>
  );
}
