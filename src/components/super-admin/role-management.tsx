"use client";

import * as React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Plus, Trash2, Loader2, ShieldCheck, Search } from "lucide-react";
import { toast } from "sonner";
import { useApiUrl } from "@/lib/hooks/use-api-url";
import { useQueryClient } from "@tanstack/react-query";
import { useT } from "@/lib/i18n/store";
import {
  SettingsCardHeader, SectionLabel, LoadingCard, ErrorCard,
} from "./_shared";
import { ALL_PERMISSIONS, PLATFORM_PERMISSIONS, TENANT_PERMISSIONS, PORTAL_CLIENT_PERMISSIONS } from "@/lib/permissions/catalog";

interface RoleOverride {
  id: string;
  tenant_id: string | null;
  role: string;
  mode: "grant" | "deny";
  permissions: string[];
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface SodRule {
  id: string;
  name: string;
  description: string | null;
  permissions_a: string[];
  permissions_b: string[];
  severity: "block" | "warn";
  active: boolean;
}

export function RoleManagement() {
  return (
    <div className="space-y-6">
      <RoleOverridesCard />
      <SodMatrixCard />
      <PermissionCatalogCard />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */
/*  Role overrides                                                          */
/* ─────────────────────────────────────────────────────────────────────── */

function RoleOverridesCard() {
  const api = useApiUrl();
  const qc = useQueryClient();
  const t = useT();

  const [overrides, setOverrides] = React.useState<RoleOverride[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(api("/api/admin/role-overrides"), { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setOverrides(d.overrides);
    } catch (e: any) {
      setError(e?.message || "Failed to load role overrides");
    } finally {
      setLoading(false);
    }
  }, [api]);

  React.useEffect(() => { void load(); }, [load]);

  async function handleDelete(id: string) {
    try {
      const r = await fetch(api(`/api/admin/role-overrides?id=${encodeURIComponent(id)}`), { method: "DELETE" });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${r.status}`);
      }
      toast.success("Role override deleted");
      qc.invalidateQueries({ queryKey: ["role-overrides"] });
      void load();
    } catch (e: any) {
      toast.error("Failed to delete role override", { description: e?.message });
    }
  }

  if (loading) return <LoadingCard title={t("pf-sa-ac-roles-title")} />;
  if (error || !overrides) return <ErrorCard title={t("pf-sa-ac-roles-title")} message={error || "No data"} />;

  const filtered = overrides.filter((o) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      o.role.toLowerCase().includes(q) ||
      (o.notes || "").toLowerCase().includes(q) ||
      o.permissions.some((p) => p.toLowerCase().includes(q))
    );
  });

  return (
    <Card className="border-border/60 shadow-soft rounded-xl">
      <SettingsCardHeader
        title={t("pf-sa-ac-roles-title")}
        description={t("pf-sa-ac-roles-desc")}
        dirty={false}
        saving={false}
      />
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              placeholder="Search by role, permission, or note…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-7"
            />
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5 mr-1" /> New Override
          </Button>
        </div>

        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No role overrides yet. Create one to grant or deny a permission for a specific role.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Role</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Permissions</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((o) => (
                <TableRow key={o.id}>
                  <TableCell>
                    <Badge variant="outline" className="capitalize text-xs">{o.role}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={o.mode === "deny" ? "bg-destructive/10 text-destructive border-destructive/30" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30"}>
                      {o.mode}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {o.tenant_id ? (
                      <code className="text-xs text-muted-foreground">{o.tenant_id.slice(0, 8)}…</code>
                    ) : (
                      <Badge variant="outline" className="bg-primary/10 text-primary border-primary/30 text-xs uppercase">Platform</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1 max-w-md">
                      {o.permissions.slice(0, 5).map((p) => (
                        <code key={p} className="text-xs bg-muted/60 px-1 py-0.5 rounded">{p}</code>
                      ))}
                      {o.permissions.length > 5 && (
                        <span className="text-xs text-muted-foreground">+{o.permissions.length - 5} more</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                    {o.notes || "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive hover:text-destructive" onClick={() => handleDelete(o.id)}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <CreateOverrideDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => { void load(); qc.invalidateQueries({ queryKey: ["role-overrides"] }); }}
      />
    </Card>
  );
}

function CreateOverrideDialog({
  open, onOpenChange, onCreated,
}: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: () => void }) {
  const api = useApiUrl();
  const [role, setRole] = React.useState("user");
  const [mode, setMode] = React.useState<"grant" | "deny">("grant");
  const [tenantId, setTenantId] = React.useState("");
  const [perms, setPerms] = React.useState<string[]>([]);
  const [notes, setNotes] = React.useState("");
  const [permSearch, setPermSearch] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  function togglePerm(p: string) {
    setPerms((prev) => prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]);
  }

  const filteredPerms = TENANT_PERMISSIONS.filter((p) =>
    !permSearch || p.toLowerCase().includes(permSearch.toLowerCase())
  );

  async function handleSave() {
    if (perms.length === 0) { toast.error("Select at least one permission"); return; }
    setSaving(true);
    try {
      const r = await fetch(api("/api/admin/role-overrides"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role, mode, permissions: perms, notes: notes || null,
          tenant_id: tenantId || null,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      toast.success("Role override created");
      setRole("user"); setMode("grant"); setTenantId(""); setPerms([]); setNotes("");
      onCreated();
      onOpenChange(false);
    } catch (e: any) {
      toast.error("Failed to create override", { description: e?.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle>Create Role Override</DialogTitle>
          <DialogDescription>Grant or deny a set of permissions for a specific role, optionally scoped to one tenant.</DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Role</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="super_admin">super_admin</SelectItem>
                <SelectItem value="admin">admin</SelectItem>
                <SelectItem value="user">user</SelectItem>
                <SelectItem value="manager">manager</SelectItem>
                <SelectItem value="accountant">accountant</SelectItem>
                <SelectItem value="portal_client">portal_client</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Mode</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as "grant" | "deny")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="grant">grant (add)</SelectItem>
                <SelectItem value="deny">deny (subtract)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Tenant ID (optional — leave blank for platform-wide)</Label>
            <Input value={tenantId} onChange={(e) => setTenantId(e.target.value)} placeholder="e.g. 7e3f8c2a-…" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Why this override? (auditable)" />
          </div>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Permissions ({perms.length} selected)</Label>
            <Input
              placeholder="Filter permissions…"
              value={permSearch}
              onChange={(e) => setPermSearch(e.target.value)}
              className="w-48 h-8 text-xs"
            />
          </div>
          <div className="max-h-56 overflow-y-auto custom-scroll border rounded-md p-2 grid grid-cols-2 gap-1">
            {filteredPerms.map((p) => (
              <label key={p} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-muted/40 px-2 py-1 rounded">
                <input
                  type="checkbox"
                  checked={perms.includes(p)}
                  onChange={() => togglePerm(p)}
                  className="size-3"
                />
                <code className="truncate">{p}</code>
              </label>
            ))}
          </div>
        </div>
        </div>
        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || perms.length === 0}>
            {saving && <Loader2 className="size-4 mr-1.5 animate-spin" />}
            Create Override
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */
/*  SoD matrix                                                              */
/* ─────────────────────────────────────────────────────────────────────── */

function SodMatrixCard() {
  const api = useApiUrl();
  const qc = useQueryClient();
  const t = useT();

  const [rules, setRules] = React.useState<SodRule[] | null>(null);
  const [defaults, setDefaults] = React.useState<SodRule[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(api("/api/admin/sod-matrix"), { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setRules(d.rules);
      setDefaults(d.defaults);
    } catch (e: any) {
      setError(e?.message || "Failed to load SoD matrix");
    } finally {
      setLoading(false);
    }
  }, [api]);

  React.useEffect(() => { void load(); }, [load]);

  const dirty = rules && defaults ? JSON.stringify(rules) !== JSON.stringify(defaults) : false;

  function patchRule(id: string, patch: Partial<SodRule>) {
    setRules((rs) => rs ? rs.map((r) => r.id === id ? { ...r, ...patch } : r) : rs);
  }
  function addRule() {
    const newRule: SodRule = {
      id: `sod-${Date.now()}`,
      name: "New Rule",
      description: "",
      permissions_a: [],
      permissions_b: [],
      severity: "warn",
      active: true,
    };
    setRules((rs) => rs ? [...rs, newRule] : [newRule]);
  }
  function deleteRule(id: string) {
    setRules((rs) => rs ? rs.filter((r) => r.id !== id) : rs);
  }

  async function save() {
    if (!rules) return;
    setSaving(true);
    try {
      const r = await fetch(api("/api/admin/sod-matrix"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setRules(d.rules);
      toast.success("SoD matrix saved", { description: `${rules.length} rules persisted.` });
      qc.invalidateQueries({ queryKey: ["sod-matrix"] });
    } catch (e: any) {
      toast.error("Failed to save SoD matrix", { description: e?.message });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingCard title={t("pf-sa-ac-sod-title")} />;
  if (error || !rules) return <ErrorCard title={t("pf-sa-ac-sod-title")} message={error || "No data"} />;

  return (
    <Card className="border-border/60 shadow-soft rounded-xl">
      <SettingsCardHeader
        title={t("pf-sa-ac-sod-title")}
        description={t("pf-sa-ac-sod-desc")}
        dirty={!!dirty}
        saving={saving}
        onSave={save}
        onReset={() => defaults && setRules(defaults)}
      />
      <CardContent className="space-y-3">
        <div className="flex items-center justify-end">
          <Button size="sm" variant="outline" onClick={addRule}>
            <Plus className="size-3.5 mr-1" /> Add Rule
          </Button>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Permission Set A</TableHead>
              <TableHead>Permission Set B</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>Active</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <Input value={r.name} onChange={(e) => patchRule(r.id, { name: e.target.value })} className="h-8" />
                </TableCell>
                <TableCell>
                  <Input
                    value={r.permissions_a.join(", ")}
                    onChange={(e) => patchRule(r.id, { permissions_a: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                    className="h-8 font-mono text-xs"
                    placeholder="invoices.create"
                  />
                </TableCell>
                <TableCell>
                  <Input
                    value={r.permissions_b.join(", ")}
                    onChange={(e) => patchRule(r.id, { permissions_b: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                    className="h-8 font-mono text-xs"
                    placeholder="invoices.send"
                  />
                </TableCell>
                <TableCell>
                  <Select value={r.severity} onValueChange={(v) => patchRule(r.id, { severity: v as "block" | "warn" })}>
                    <SelectTrigger className="h-8 w-24"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="block">block</SelectItem>
                      <SelectItem value="warn">warn</SelectItem>
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell>
                  <Switch checked={r.active} onCheckedChange={(v) => patchRule(r.id, { active: v })} />
                </TableCell>
                <TableCell className="text-right">
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive hover:text-destructive" onClick={() => deleteRule(r.id)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {rules.length === 0 && (
          <p className="text-sm text-muted-foreground py-4 text-center">No SoD rules. Add one or reset to defaults.</p>
        )}
      </CardContent>
    </Card>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */
/*  Permission catalog                                                      */
/* ─────────────────────────────────────────────────────────────────────── */

function PermissionCatalogCard() {
  const [search, setSearch] = React.useState("");
  const t = useT();

  const allPerms = React.useMemo(() => {
    return ALL_PERMISSIONS.map((p) => ({
      key: p,
      scope: p.startsWith("platform.")
        ? "platform"
        : p.startsWith("portal.")
        ? "portal-client"
        : "tenant",
    }));
  }, []);

  const filtered = allPerms.filter((p) =>
    !search || p.key.toLowerCase().includes(search.toLowerCase())
  );

  const scopeBadge = (scope: string) => {
    if (scope === "platform") return "bg-primary/10 text-primary border-primary/30";
    if (scope === "portal-client") return "bg-chart-3/10 text-chart-3 border-chart-3/30";
    return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30";
  };

  return (
    <Card className="border-border/60 shadow-soft rounded-xl">
      <SettingsCardHeader
        title={t("pf-sa-ac-catalog-title")}
        description={`${t("pf-sa-ac-catalog-desc")} ${allPerms.length} permissions across ${PLATFORM_PERMISSIONS.length} platform, ${TENANT_PERMISSIONS.length} tenant-scoped, and ${PORTAL_CLIENT_PERMISSIONS.length} portal-client scopes.`}
        dirty={false}
        saving={false}
      />
      <CardContent className="space-y-3">
        <Input
          placeholder="Filter by key… (e.g. invoices, erp, platform)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-md"
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5 max-h-96 overflow-y-auto custom-scroll border rounded-md p-2">
          {filtered.map((p) => (
            <div key={p.key} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted/40">
              <code className="text-xs font-mono flex-1 truncate">{p.key}</code>
              <Badge variant="outline" className={`text-[9px] uppercase tracking-wider ${scopeBadge(p.scope)}`}>
                {p.scope}
              </Badge>
            </div>
          ))}
          {filtered.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4 col-span-full">No permissions match.</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
