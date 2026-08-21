"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetFooter } from "@/components/ui/sheet";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { UserCheck, KeyRound, ShieldOff, Search, Loader2, Users, Filter, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { ALL_PERMISSIONS, PLATFORM_PERMISSIONS, PORTAL_CLIENT_PERMISSIONS } from "@/lib/permissions/catalog";
import { useT } from "@/lib/i18n/store";
import { useAppStore, isSuperAdmin } from "@/lib/store/app-store";
import { PageHeader } from "@/components/common/page-header";

interface PlatformUser {
  id: string; tenant_id: string | null; username: string; email: string;
  full_name: string | null; role: string; permissions: string[] | null;
  active: boolean; last_login_at?: string | null;
}
interface Tenant { id: string; name: string; plan: string; }

const TENANT_PERMS = ALL_PERMISSIONS.filter(
  (p) => !PLATFORM_PERMISSIONS.includes(p as any) && !PORTAL_CLIENT_PERMISSIONS.includes(p as any),
);

/** Groups a flat permission list by its resource prefix ("partners.*"). */
function groupPerms(perms: readonly string[]) {
  const g: Record<string, string[]> = {};
  perms.forEach((p) => {
    const dot = p.indexOf(".");
    const res = dot > 0 ? p.slice(0, dot) : p;
    (g[res] ??= []).push(p);
  });
  return g;
}
const GROUPED = groupPerms(TENANT_PERMS);

export function PlatformUsersView() {
  const qc = useQueryClient();
  const t = useT();
  const [search, setSearch] = React.useState("");
  const [tenantFilter, setTenantFilter] = React.useState<string>("all");
  const [roleFilter, setRoleFilter] = React.useState<string>("all");
  const [editing, setEditing] = React.useState<PlatformUser | null>(null);
  const userObj = useAppStore((s) => s.user);
  const isSuper = isSuperAdmin(userObj);

  // Defense-in-depth: super-admin-only surface. The sidebar hides this
  // view and /api/super-admin/users uses requireSuperAdmin, but if a
  // non-super-admin reaches it via state manipulation we render a clear
  // denial instead of firing 403 fetches. `enabled: isSuper` below
  // short-circuits the queries; hooks must be called before the early
  // return (Rules of Hooks).

  const usersQ = useQuery({
    queryKey: ["platform-users"],
    queryFn: async () => {
      const r = await fetch("/api/super-admin/users");
      if (!r.ok) throw new Error(t("pf-failed-load-users"));
      return r.json() as Promise<{ items: PlatformUser[] }>;
    },
    enabled: isSuper,
  });
  const tenantsQ = useQuery({
    queryKey: ["platform-users-tenants"],
    queryFn: async () => {
      const r = await fetch("/api/tenants");
      return r.ok ? (r.json() as Promise<{ items: Tenant[] }>) : { items: [] };
    },
    enabled: isSuper,
  });

  if (!isSuper) {
    return (
      <div>
        <PageHeader title={t("pf-all-users")} description={t("pf-users-desc")} />
        <Card className="border-amber-500/30 bg-amber-50/40 dark:bg-amber-500/5">
          <CardContent className="p-6 flex items-start gap-3">
            <div className="size-10 rounded-xl bg-amber-500/15 text-amber-600 flex items-center justify-center shrink-0">
              <ShieldAlert className="size-5" />
            </div>
            <div>
              <p className="font-medium">Platform admin access required.</p>
              <p className="text-sm text-muted-foreground mt-1">
                This area is restricted to platform super-administrators. Contact your platform operator if you believe this is an error.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const items = usersQ.data?.items || [];
  const tenants = tenantsQ.data?.items || [];
  const tenantName = React.useMemo(() => new Map(tenants.map((t) => [t.id, t.name])), [tenants]);

  const filtered = items.filter((u) => {
    if (tenantFilter === "__platform__") { if (u.tenant_id) return false; }
    else if (tenantFilter !== "all" && (u.tenant_id || "") !== tenantFilter) return false;
    if (roleFilter !== "all" && u.role !== roleFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q) || (u.full_name || "").toLowerCase().includes(q);
    }
    return true;
  });

  const impersonateMut = useMutation({
    mutationFn: async (u: PlatformUser) => {
      const r = await fetch("/api/super-admin/impersonate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: u.id, tenant_id: u.tenant_id, duration_minutes: 60 }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || t("pf-failed-impersonate"));
    },
    onSuccess: () => { toast.success(t("pf-impersonation-started")); setTimeout(() => window.location.reload(), 400); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div><CardTitle className="flex items-center gap-2 text-base"><Users className="size-4 text-primary" /> {t("pf-all-users")}</CardTitle><CardDescription className="text-xs">{t("pf-users-desc")}</CardDescription></div>
            <Badge variant="outline">{filtered.length} {t("pf-of")} {items.length}</Badge>
          </div>
        </CardHeader>
        <CardContent className="pt-0 space-y-3">
          <div className="flex flex-wrap gap-2 items-center">
            <div className="relative flex-1 min-w-[200px]"><Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" /><Input placeholder={t("pf-users-search-placeholder")} value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8" /></div>
            <Select value={tenantFilter} onValueChange={setTenantFilter}>
              <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("pf-all-tenants")}</SelectItem>
                <SelectItem value="__platform__">{t("pf-platform-super-admin")}</SelectItem>
                {tenants.map((tn) => <SelectItem key={tn.id} value={tn.id}>{tn.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={roleFilter} onValueChange={setRoleFilter}>
              <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("pf-all-roles")}</SelectItem>
                <SelectItem value="super_admin">{t("pf-role-super-admin")}</SelectItem>
                <SelectItem value="admin">{t("pf-role-admin")}</SelectItem>
                <SelectItem value="user">{t("pf-role-user")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="border rounded-lg overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("pf-user")}</TableHead>
                  <TableHead>{t("pf-tenant")}</TableHead>
                  <TableHead>{t("pf-role")}</TableHead>
                  <TableHead className="text-right">{t("pf-perms")}</TableHead>
                  <TableHead>{t("active")}</TableHead>
                  <TableHead className="text-right">{t("actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usersQ.isLoading && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">{t("loading")}</TableCell></TableRow>}
                {!usersQ.isLoading && filtered.length === 0 && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">{t("pf-no-users-match")}</TableCell></TableRow>}
                {filtered.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell><div className="min-w-0"><p className="text-sm font-medium">{u.username}</p><p className="text-xs text-muted-foreground truncate max-w-[200px]">{u.email}</p></div></TableCell>
                    <TableCell className="text-sm">{u.tenant_id ? tenantName.get(u.tenant_id) || u.tenant_id.slice(0, 8) : <span className="text-primary font-semibold">{t("pf-platform-badge")}</span>}</TableCell>
                    <TableCell><Badge variant={u.role === "super_admin" ? "destructive" : "outline"}>{u.role}</Badge></TableCell>
                    <TableCell className="text-right tabular text-sm">{(u.permissions?.length) ?? 0}</TableCell>
                    <TableCell>{u.active ? <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30">{t("active")}</Badge> : <Badge variant="secondary">{t("pf-off")}</Badge>}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {u.role !== "super_admin" && u.active && (
                          <Button size="icon" variant="ghost" className="size-8 text-amber-600" title={t("pf-impersonate")} onClick={() => { if (confirm(t("pf-impersonate-confirm").replace("{username}", u.username))) impersonateMut.mutate(u); }}>
                            <UserCheck className="size-4" />
                          </Button>
                        )}
                        {u.role !== "super_admin" && (
                          <Button size="icon" variant="ghost" className="size-8" title={t("pf-edit-permissions")} onClick={() => setEditing(u)}>
                            <KeyRound className="size-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {editing && <PermissionEditor user={editing} tenantName={editing.tenant_id ? tenantName.get(editing.tenant_id) || editing.tenant_id : t("pf-platform-badge")} onClose={() => setEditing(null)} onSaved={() => { qc.invalidateQueries({ queryKey: ["platform-users"] }); setEditing(null); }} />}
    </div>
  );
}

function PermissionEditor({ user, tenantName, onClose, onSaved }: {
  user: PlatformUser; tenantName: string; onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  const [perms, setPerms] = React.useState<string[]>(user.permissions || []);
  const [saving, setSaving] = React.useState(false);
  const [wildcard, setWildcard] = React.useState(user.permissions?.includes("*") || false);

  function togglePerm(p: string) {
    setPerms((cur) => cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]);
  }
  function toggleResource(res: string, all: string[], on: boolean) {
    setPerms((cur) => {
      const cleared = cur.filter((p) => !all.includes(p) && p !== `${res}.*`);
      if (!on) return cleared;
      return [...cleared, `${res}.*`];
    });
  }

  async function save() {
    setSaving(true);
    try {
      const final = wildcard ? ["*"] : perms;
      const r = await fetch(`/api/users/${user.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: final }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || t("pf-failed-save-http").replace("{status}", String(r.status)));
      toast.success(t("pf-permissions-updated").replace("{username}", user.username));
      onSaved();
    } catch (e: any) {
      toast.error(e.message || t("pf-save-failed"));
    } finally { setSaving(false); }
  }

  const isAdmin = user.role === "admin";

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto custom-scroll">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2"><KeyRound className="size-5 text-primary" /> {user.username}</SheetTitle>
          <SheetDescription>{tenantName} · {t("pf-role-label")} <Badge variant="outline">{user.role}</Badge></SheetDescription>
        </SheetHeader>
        <div className="py-4 space-y-4">
          {isAdmin && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400">
              {t("pf-admin-implicit")}
            </div>
          )}
          <label className="flex items-center gap-2 rounded-lg border p-3 cursor-pointer hover:bg-muted/40">
            <Checkbox checked={wildcard} onCheckedChange={(v) => setWildcard(v === true)} />
            <div><p className="text-sm font-medium">{t("pf-grant-everything")}</p><p className="text-xs text-muted-foreground">{t("pf-grant-everything-desc")}</p></div>
          </label>
          {!wildcard && (
            <div className="space-y-3">
              {Object.entries(GROUPED).map(([res, list]) => {
                const allChecked = list.every((p) => perms.includes(p)) || perms.includes(`${res}.*`);
                const someChecked = list.some((p) => perms.includes(p)) || perms.includes(`${res}.*`);
                return (
                  <div key={res} className="rounded-lg border p-3">
                    <div className="flex items-center justify-between mb-2">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <Checkbox checked={allChecked} onCheckedChange={(v) => toggleResource(res, list, v === true)} />
                        <span className="text-sm font-semibold capitalize">{res.replace(/-/g, " ")}</span>
                        {someChecked && !allChecked && <span className="text-xs text-muted-foreground">{t("pf-partial")}</span>}
                      </label>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 pl-6">
                      {list.map((p) => (
                        <label key={p} className="flex items-center gap-2 text-xs cursor-pointer">
                          <Checkbox checked={perms.includes(p) || perms.includes(`${res}.*`)} onCheckedChange={() => togglePerm(p)} disabled={perms.includes(`${res}.*`)} />
                          {p.replace(`${res}.`, "")}
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <SheetFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>{t("cancel")}</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="size-4 mr-2 animate-spin" /> : null}
            {t("pf-save-permissions")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
