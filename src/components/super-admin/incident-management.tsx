"use client";

import * as React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Plus, Loader2, ShieldAlert, Clock, CheckCircle2, AlertTriangle, FileText } from "lucide-react";
import { toast } from "sonner";
import { useApiUrl } from "@/lib/hooks/use-api-url";
import { useQueryClient } from "@tanstack/react-query";
import { useT } from "@/lib/i18n/store";
import {
  SettingsCardHeader, SectionLabel, LoadingCard, ErrorCard,
} from "./_shared";
import { fmtDateTime, fmtRelative } from "@/lib/utils/format";

// ---------------------------------------------------------------------------
// Types — aligned with the backend SecurityIncident shape
// (src/lib/compliance/incident-response.ts + migration 039_security_incidents.sql).
//
// The DB CHECK constraints enforce:
//   type:     data_breach | unauthorized_access | malware | system_compromise | phishing | other
//   severity: low | medium | high | critical
//   status:   open | investigating | contained | resolved | reported
//
// `closed` is intentionally NOT in the status union (the DB would reject it).
// `breach_notification_*` fields were renamed in V-3 to mirror the actual
// DB columns: `gdpr_notification_deadline`, `gdpr_notified`, `reported_at`.
// `owner` → `created_by`. `timeline` has no DB column → surfaced as an
// empty array (the "Add Timeline Note" UI section was a no-op; the proper
// path is to use the audit_logs trail which already records every update).
// ---------------------------------------------------------------------------

type IncidentStatus = "open" | "investigating" | "contained" | "resolved" | "reported";
type IncidentSeverity = "low" | "medium" | "high" | "critical";
type IncidentType =
  | "data_breach"
  | "unauthorized_access"
  | "malware"
  | "system_compromise"
  | "phishing"
  | "other";

interface Incident {
  id: string;
  tenant_id: string | null;
  type: IncidentType;
  severity: IncidentSeverity;
  status: IncidentStatus;
  detected_at: string;
  reported_at: string | null;
  affected_tenants: string[];
  affected_users: string[];
  description: string;
  root_cause: string | null;
  mitigation_steps: string[];
  gdpr_notified: boolean;
  gdpr_notification_deadline: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const STATUS_BADGE: Record<IncidentStatus, string> = {
  open: "bg-destructive/10 text-destructive border-destructive/30",
  investigating: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
  contained: "bg-chart-4/15 text-chart-4 border-chart-4/30",
  resolved: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  reported: "bg-primary/10 text-primary border-primary/30",
};

const SEVERITY_BADGE: Record<IncidentSeverity, string> = {
  low: "bg-muted text-muted-foreground border-border",
  medium: "bg-chart-4/15 text-chart-4 border-chart-4/30",
  high: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
  critical: "bg-destructive/10 text-destructive border-destructive/30",
};

const TYPE_LABEL: Record<IncidentType, string> = {
  data_breach: "Data Breach",
  unauthorized_access: "Unauthorized Access",
  malware: "Malware",
  system_compromise: "System Compromise",
  phishing: "Phishing",
  other: "Other",
};

// Static runbook steps per incident type — surfaced read-only in the
// incident-detail dialog. Sourced from the SOC2 / GDPR playbook.
// Mirrors `INCIDENT_RESPONSE_STEPS` in src/lib/compliance/incident-response.ts.
const RUNBOOKS: Record<IncidentType, Array<{ step: string; description: string }>> = {
  data_breach: [
    { step: "1. Detect & confirm", description: "Verify the breach is real (not a false positive from anomaly detection / monitoring)." },
    { step: "2. Contain", description: "Revoke sessions, rotate affected credentials (vault-management → rotate keys), block offending IPs." },
    { step: "3. Assess scope", description: "Identify affected tenants, users, PII fields. Document in this incident's description." },
    { step: "4. Notify DPO", description: "Alert the DPO (gdpr_config.dpoEmail) within 24h of detection." },
    { step: "5. Notify authority (72h)", description: "GDPR Art. 33: notify the supervisory authority within 72h. Use the 'Mark Breach Notification Sent' button which calls POST /notify." },
    { step: "6. Notify data subjects", description: "GDPR Art. 34: notify affected data subjects without undue delay if high risk." },
    { step: "7. Post-incident review", description: "Root-cause analysis; update SoD matrix / anomaly thresholds / access controls." },
  ],
  unauthorized_access: [
    { step: "1. Kill session", description: "Revoke all sessions for the user; rotate their password reset token." },
    { step: "2. Trace", description: "Audit login_history + audit_logs for the IP / device / time window." },
    { step: "3. Rotate secrets", description: "If vault or API keys were accessed, rotate them via vault-management." },
    { step: "4. Notify", description: "If PII was exposed, treat as a breach and follow the breach runbook." },
  ],
  malware: [
    { step: "1. Isolate", description: "Take affected systems offline if possible." },
    { step: "2. Identify", description: "Identify the malware strain and entry vector." },
    { step: "3. Scan", description: "Run full AV/EDR scan on all hosts in the affected tenant." },
    { step: "4. Restore", description: "Restore from known-clean backup if data was encrypted/exfiltrated." },
    { step: "5. Patch", description: "Patch the entry vector (vulnerability, phishing vector, supply chain)." },
    { step: "6. Document", description: "Document incident and post-incident review." },
  ],
  system_compromise: [
    { step: "1. Rotate ALL secrets", description: "SECRET_KEY, JWT_SECRET_KEY, VAULT_KEY_V2, FIELD_ENCRYPTION_KEY, SUPABASE_SERVICE_ROLE_KEY, CRON_TOKEN." },
    { step: "2. Revoke sessions", description: "Revoke every active session (bump token_version for all users)." },
    { step: "3. Audit super_admin", description: "Review every super_admin action in audit_logs for the compromise window." },
    { step: "4. Inspect code", description: "Inspect deployed code for backdoors (git diff against last known-good commit)." },
    { step: "5. Notify tenants", description: "Notify tenants whose data was accessible to the attacker." },
    { step: "6. Forensic snapshot", description: "Forensic snapshot of the DB + filesystem for evidence." },
    { step: "7. Document", description: "Document incident, root cause, and remediation." },
  ],
  phishing: [
    { step: "1. Identify vector", description: "Identify the phishing vector (email, fake login page, etc.)." },
    { step: "2. Block", description: "Block the sender / URL at the perimeter (email gateway, WAF)." },
    { step: "3. Force reset", description: "Force password reset + 2FA re-enrollment for users who clicked." },
    { step: "4. Notify users", description: "Notify affected users with a security advisory." },
    { step: "5. Train staff", description: "Train staff on the phishing pattern (post-incident)." },
    { step: "6. Document", description: "Document incident." },
  ],
  other: [
    { step: "1. Triage", description: "Assess severity and impact." },
    { step: "2. Contain", description: "Take immediate action to limit impact." },
    { step: "3. Document", description: "Document the incident type and root cause." },
    { step: "4. Determine notification", description: "Determine if GDPR / SOC 2 / contractual notification is required." },
    { step: "5. Close", description: "Resolve once the impact is fully mitigated." },
  ],
};

export function IncidentManagement() {
  const api = useApiUrl();
  const qc = useQueryClient();
  const t = useT();

  const [incidents, setIncidents] = React.useState<Incident[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [statusFilter, setStatusFilter] = React.useState<string>("");

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = statusFilter
        ? api(`/api/admin/incidents?status=${encodeURIComponent(statusFilter)}`)
        : api("/api/admin/incidents");
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      // Backend returns `{ items, total, limit, offset }` — read `items`.
      setIncidents((d.items ?? []) as Incident[]);
    } catch (e: any) {
      setError(e?.message || "Failed to load incidents");
    } finally {
      setLoading(false);
    }
  }, [api, statusFilter]);

  // Fetch on mount; load() calls setState after `await fetch` so it isn't
  // synchronous, but the rule's static analysis can't follow the promise.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  React.useEffect(() => { void load(); }, [load]);

  const selected = incidents?.find((i) => i.id === selectedId) || null;

  // PUT the incident's mutable fields. Matches the backend allowlist at
  // src/app/api/admin/incidents/[id]/route.ts (PUT export). The body is
  // a partial SecurityIncident — only `status`, `type`, `severity`,
  // `description`, `root_cause`, `mitigation_steps`, `affected_tenants`,
  // `affected_users`, `tenant_id`, `gdpr_notified`, `reported_at` are
  // honoured by the API.
  async function updateIncident(id: string, patch: Partial<Incident>) {
    try {
      const r = await fetch(api(`/api/admin/incidents/${encodeURIComponent(id)}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      toast.success("Incident updated");
      qc.invalidateQueries({ queryKey: ["incidents"] });
      void load();
    } catch (e: any) {
      toast.error("Failed to update incident", { description: e?.message });
    }
  }

  // Trigger the GDPR Art. 33 supervisory-authority notification flow
  // atomically — sends the email, flips `gdpr_notified=true`, sets
  // `reported_at`, escalates `status` to `reported`, and audits the
  // dispatch. Routes through POST /api/admin/incidents/[id]/notify
  // (NOT the broken PUT path that previously sent a wrong field name).
  async function notifyAuthority(id: string, force = false) {
    try {
      const r = await fetch(
        api(`/api/admin/incidents/${encodeURIComponent(id)}/notify`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force }),
        },
      );
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      toast.success("Breach notification sent", {
        description: d.message_id ? `Message ID: ${d.message_id}` : undefined,
      });
      qc.invalidateQueries({ queryKey: ["incidents"] });
      void load();
    } catch (e: any) {
      toast.error("Failed to send breach notification", { description: e?.message });
    }
  }

  if (loading) return <LoadingCard title={t("pf-sa-inc-title")} />;
  if (error || !incidents) return <ErrorCard title={t("pf-sa-inc-title")} message={error || "No data"} />;

  const openCount = incidents.filter((i) => i.status === "open" || i.status === "investigating").length;
  const breachCount = incidents.filter((i) => i.type === "data_breach").length;
  const resolvedCount = incidents.filter((i) => i.status === "resolved" || i.status === "reported").length;

  return (
    <div className="space-y-6">
      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile label={t("pf-sa-inc-kpi-total")} value={String(incidents.length)} tone="info" />
        <Tile label={t("pf-sa-inc-kpi-open")} value={String(openCount)} tone={openCount > 0 ? "warn" : "ok"} />
        <Tile label={t("pf-sa-inc-kpi-breach")} value={String(breachCount)} tone={breachCount > 0 ? "critical" : "ok"} />
        <Tile label={t("pf-sa-inc-kpi-resolved")} value={String(resolvedCount)} tone="ok" />
      </div>

      <Card className="border-border/60 shadow-soft rounded-xl">
        <SettingsCardHeader
          title={t("pf-sa-inc-list-title")}
          description={t("pf-sa-inc-list-desc")}
          dirty={false}
          saving={false}
        />
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-44 h-8 text-xs">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">All statuses</SelectItem>
                <SelectItem value="open">open</SelectItem>
                <SelectItem value="investigating">investigating</SelectItem>
                <SelectItem value="contained">contained</SelectItem>
                <SelectItem value="resolved">resolved</SelectItem>
                <SelectItem value="reported">reported</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" onClick={() => setCreateOpen(true)} className="ml-auto bg-gradient-emerald text-white">
              <Plus className="size-3.5 mr-1" /> {t("pf-sa-inc-new")}
            </Button>
          </div>

          {incidents.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No incidents recorded. Create one to start tracking.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Detected</TableHead>
                  <TableHead>Breach Deadline</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {incidents.map((i) => {
                  const deadlinePassed = i.gdpr_notification_deadline
                    && !i.gdpr_notified
                    && new Date(i.gdpr_notification_deadline) < new Date();
                  return (
                    <TableRow key={i.id} className="hover:bg-muted/40 cursor-pointer" onClick={() => setSelectedId(i.id)}>
                      <TableCell className="font-medium">{i.description.slice(0, 80) || i.id}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">{TYPE_LABEL[i.type]}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-xs uppercase tracking-wider ${SEVERITY_BADGE[i.severity]}`}>
                          {i.severity}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-xs ${STATUS_BADGE[i.status]}`}>{i.status}</Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground tabular">{fmtRelative(i.detected_at)}</TableCell>
                      <TableCell>
                        {i.gdpr_notification_deadline ? (
                          <span className={`text-xs tabular ${deadlinePassed ? "text-destructive font-semibold" : "text-amber-600"}`}>
                            {fmtDateTime(i.gdpr_notification_deadline)}
                            {i.gdpr_notified && <Badge variant="outline" className="ml-2 text-[9px] bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30">sent</Badge>}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setSelectedId(i.id); }}>
                          Open
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <CreateIncidentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => { void load(); qc.invalidateQueries({ queryKey: ["incidents"] }); }}
      />

      {selected && (
        <IncidentDetailDialog
          incident={selected}
          onOpenChange={(v) => { if (!v) setSelectedId(null); }}
          onUpdate={(patch) => updateIncident(selected.id, patch)}
          onNotify={(force) => notifyAuthority(selected.id, force)}
        />
      )}
    </div>
  );
}

function CreateIncidentDialog({
  open, onOpenChange, onCreated,
}: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: () => void }) {
  const api = useApiUrl();
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [type, setType] = React.useState<IncidentType>("other");
  const [severity, setSeverity] = React.useState<IncidentSeverity>("medium");
  const [detectedAt, setDetectedAt] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  async function handleSave() {
    if (!title.trim()) { toast.error("Title is required"); return; }
    setSaving(true);
    try {
      const r = await fetch(api("/api/admin/incidents"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Backend uses `description` as the canonical text field; the
          // legacy `title` column was dropped — `description` carries both.
          description: title + (description ? `\n\n${description}` : ""),
          type, severity,
          detected_at: detectedAt || undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      toast.success("Incident created", {
        description: type === "data_breach"
          ? "72-hour breach-notification deadline auto-computed."
          : "Incident is now tracked in the register.",
      });
      setTitle(""); setDescription(""); setType("other"); setSeverity("medium"); setDetectedAt("");
      onCreated();
      onOpenChange(false);
    } catch (e: any) {
      toast.error("Failed to create incident", { description: e?.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] sm:max-w-2xl max-h-[88vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle>Create Security Incident</DialogTitle>
          <DialogDescription>
            Document a security event for tracking. If type is &quot;data_breach&quot;, the GDPR Art. 33 72-hour notification deadline is auto-computed.
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-3">
          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Suspected unauthorized access to vault" />
          </div>
          <div className="space-y-1.5">
            <Label>Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="What happened, what was affected, what's the initial assessment." />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={type} onValueChange={(v) => setType(v as IncidentType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(TYPE_LABEL) as IncidentType[]).map((t) => (
                    <SelectItem key={t} value={t}>{TYPE_LABEL[t]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Severity</Label>
              <Select value={severity} onValueChange={(v) => setSeverity(v as IncidentSeverity)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">low</SelectItem>
                  <SelectItem value="medium">medium</SelectItem>
                  <SelectItem value="high">high</SelectItem>
                  <SelectItem value="critical">critical</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Detected At</Label>
              <Input type="datetime-local" value={detectedAt} onChange={(e) => setDetectedAt(e.target.value)} />
            </div>
          </div>
        </div>
        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || !title.trim()} className="bg-gradient-emerald text-white">
            {saving && <Loader2 className="size-4 mr-1.5 animate-spin" />}
            Create Incident
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function IncidentDetailDialog({
  incident, onOpenChange, onUpdate, onNotify,
}: {
  incident: Incident;
  onOpenChange: (v: boolean) => void;
  onUpdate: (patch: Partial<Incident>) => Promise<void>;
  onNotify: (force?: boolean) => Promise<void>;
}) {
  const t = useT();
  const [rootCause, setRootCause] = React.useState(incident.root_cause || "");
  const [status, setStatus] = React.useState<IncidentStatus>(incident.status);
  const [savingStatus, setSavingStatus] = React.useState(false);
  const [savingRootCause, setSavingRootCause] = React.useState(false);
  const [notifying, setNotifying] = React.useState(false);

  // Resync local form state when the underlying incident changes (parent
  // passes a fresh object on save). The "store previous prop" pattern would
  // be the lint-clean alternative, but this detail panel mounts/unmounts
  // with the dialog so an effect is the simpler choice.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus(incident.status);
    setRootCause(incident.root_cause || "");
  }, [incident.id, incident.status, incident.root_cause]);

  const deadlinePassed = incident.gdpr_notification_deadline
    && !incident.gdpr_notified
    && new Date(incident.gdpr_notification_deadline) < new Date();

  async function saveStatus() {
    setSavingStatus(true);
    await onUpdate({ status });
    setSavingStatus(false);
  }
  async function saveRootCause() {
    setSavingRootCause(true);
    await onUpdate({ root_cause: rootCause });
    setSavingRootCause(false);
  }
  async function markBreachSent() {
    setNotifying(true);
    await onNotify(false);
    setNotifying(false);
  }
  async function resendBreachNotification() {
    setNotifying(true);
    await onNotify(true);
    setNotifying(false);
  }

  return (
    <Dialog open={!!incident} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] sm:max-w-3xl max-h-[88vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <ShieldAlert className="size-4 text-destructive" />
            {incident.description.slice(0, 100) || incident.id}
            <Badge variant="outline" className={`text-xs uppercase tracking-wider ${SEVERITY_BADGE[incident.severity]}`}>
              {incident.severity}
            </Badge>
          </DialogTitle>
          <DialogDescription>
            <Badge variant="outline" className="text-xs mr-2">{TYPE_LABEL[incident.type]}</Badge>
            Detected {fmtDateTime(incident.detected_at)} by <strong>{incident.created_by || "—"}</strong>
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
          {incident.description && (
            <div className="bg-muted/40 rounded-md p-3 text-sm whitespace-pre-wrap">{incident.description}</div>
          )}

          {incident.gdpr_notification_deadline && (
            <div className={`rounded-md border p-3 text-sm ${deadlinePassed ? "border-destructive/40 bg-destructive/5" : "border-amber-500/30 bg-amber-500/5"}`}>
              <div className="flex items-center gap-2 font-medium mb-1">
                <Clock className="size-4" />
                GDPR Art. 33 Breach Notification
              </div>
              <div className="text-xs text-muted-foreground space-y-1">
                <p>Deadline: <span className={`tabular font-mono ${deadlinePassed ? "text-destructive" : ""}`}>{fmtDateTime(incident.gdpr_notification_deadline)}</span></p>
                {incident.gdpr_notified ? (
                  <div className="space-y-1">
                    <p className="text-emerald-600 font-medium">✓ Notification sent at {fmtDateTime(incident.reported_at)}</p>
                    <Button size="sm" variant="outline" className="mt-1" onClick={resendBreachNotification} disabled={notifying}>
                      {notifying && <Loader2 className="size-3.5 mr-1 animate-spin" />}
                      Re-send Follow-up Notification (Art. 33(4))
                    </Button>
                  </div>
                ) : deadlinePassed ? (
                  <p className="text-destructive font-semibold">⚠ Deadline passed — notify the supervisory authority immediately.</p>
                ) : (
                  <Button size="sm" variant="outline" className="mt-2" onClick={markBreachSent} disabled={notifying}>
                    {notifying && <Loader2 className="size-3.5 mr-1 animate-spin" />}
                    Send Breach Notification
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Status editor */}
          <div className="flex items-center gap-2">
            <Label className="text-sm">Status:</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as IncidentStatus)}>
              <SelectTrigger className="w-44 h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="open">open</SelectItem>
                <SelectItem value="investigating">investigating</SelectItem>
                <SelectItem value="contained">contained</SelectItem>
                <SelectItem value="resolved">resolved</SelectItem>
                <SelectItem value="reported">reported</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" onClick={saveStatus} disabled={savingStatus || status === incident.status}>
              {savingStatus && <Loader2 className="size-3.5 mr-1 animate-spin" />}
              Update Status
            </Button>
          </div>

          {/* Root cause editor */}
          <div className="space-y-2">
            <Label className="text-sm">Root Cause</Label>
            <Textarea
              value={rootCause}
              onChange={(e) => setRootCause(e.target.value)}
              rows={2}
              placeholder="What caused this incident? Document for the post-incident review."
            />
            <Button size="sm" variant="outline" onClick={saveRootCause} disabled={savingRootCause || rootCause === (incident.root_cause || "")}>
              {savingRootCause && <Loader2 className="size-3.5 mr-1 animate-spin" />}
              Save Root Cause
            </Button>
          </div>

          {/* Runbook */}
          <div>
            <SectionLabel hint={`runbook · ${TYPE_LABEL[incident.type]}`}>{t("pf-sa-inc-runbook-title")}</SectionLabel>
            <ol className="space-y-2 text-sm">
              {RUNBOOKS[incident.type].map((s, i) => (
                <li key={i} className="flex gap-2">
                  <span className="font-mono text-xs bg-muted/60 rounded px-1.5 py-0.5 h-fit">{i + 1}</span>
                  <div>
                    <p className="font-medium text-xs">{s.step}</p>
                    <p className="text-xs text-muted-foreground">{s.description}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>

        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone: "ok" | "warn" | "info" | "critical" }) {
  const cls = {
    ok: "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400",
    warn: "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400",
    info: "border-primary/30 bg-primary/5",
    critical: "border-destructive/30 bg-destructive/5 text-destructive",
  }[tone];
  return (
    <div className={`rounded-xl border ${cls} p-3`}>
      <p className="text-xs uppercase tracking-wider opacity-70">{label}</p>
      <p className="text-xl font-bold tabular mt-1">{value}</p>
    </div>
  );
}
