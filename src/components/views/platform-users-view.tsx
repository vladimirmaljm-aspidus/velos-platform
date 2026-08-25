"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetFooter } from "@/components/ui/sheet";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  UserCheck, KeyRound, ShieldOff, Search, Loader2, Users, Filter, ShieldAlert,
  Plus, Trash2, Eye, EyeOff, Lock, ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { ALL_PERMISSIONS, PLATFORM_PERMISSIONS, PORTAL_CLIENT_PERMISSIONS } from "@/lib/permissions/catalog";
import { useT } from "@/lib/i18n/store";
import { useAppStore, isSuperAdmin } from "@/lib/store/app-store";
import { PageHeader } from "@/components/common/page-header";
import { ModuleInfoTooltip } from "@/components/common/module-info-tooltip";


interface PlatformUser {
  id: string; tenant_id: string | null; username: string; email: string;
  full_name: string | null; role: string; permissions: string[] | null;
  active: boolean; last_login_at?: string | null;
  // `totp_enabled` is exposed by /api/super-admin/users (the route strips
  // password_hash + totp_secret but leaves this flag so the platform
  // users view can show a "2FA on" badge and offer the disable action).
  totp_enabled?: boolean;
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
  // ── Dialog / confirmation state ──────────────────────────────────────
  // `showCreate` toggles the Create User dialog. `resetTarget` /
  // `deleteTarget` / `disable2faTarget` carry the row the operator is
  // acting on; their presence is what opens the corresponding
  // AlertDialog. We carry the full PlatformUser (not just the id) so the
  // dialogs can render the user's username / email without a second
  // lookup.
  const [showCreate, setShowCreate] = React.useState(false);
  const [resetTarget, setResetTarget] = React.useState<PlatformUser | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<PlatformUser | null>(null);
  const [disable2faTarget, setDisable2faTarget] = React.useState<PlatformUser | null>(null);
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

  // useMemo and useMutation must run unconditionally to comply with
  // react-hooks/rules-of-hooks. The access-denied early return is placed
  // AFTER all hook calls below.
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

  // ── Mutations: delete / reset-password / change-role / disable-2fa ──
  //
  // Each mutation hits a dedicated API route and invalidates the
  // `["platform-users"]` query cache so the table reflects the change on
  // success. None of them close the dialog themselves — the dialog's
  // `onSuccess` callback handles both the invalidation and the close so
  // the toast can stack on top of the dismissal (otherwise the toast
  // might fire while the dialog is animating away and look like it
  // belonged to the next view).

  const deleteMut = useMutation({
    mutationFn: async (u: PlatformUser) => {
      const r = await fetch(`/api/users/${u.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || t("pf-delete-failed"));
    },
    onSuccess: () => {
      toast.success(t("pf-delete-toast"));
      qc.invalidateQueries({ queryKey: ["platform-users"] });
      setDeleteTarget(null);
    },
    onError: (e: Error) => toast.error(e.message || t("pf-delete-failed")),
  });

  const resetPwMut = useMutation({
    mutationFn: async ({ u, password }: { u: PlatformUser; password: string }) => {
      const r = await fetch(`/api/users/${u.id}/reset-password`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || t("pf-reset-password-failed"));
    },
    onSuccess: () => {
      toast.success(t("pf-reset-password-toast"));
      setResetTarget(null);
    },
    onError: (e: Error) => toast.error(e.message || t("pf-reset-password-failed")),
  });

  const changeRoleMut = useMutation({
    mutationFn: async ({ u, role }: { u: PlatformUser; role: string }) => {
      const r = await fetch(`/api/users/${u.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || t("pf-role-change-failed"));
    },
    onSuccess: (_d, vars) => {
      toast.success(t("pf-role-change-toast").replace("{username}", vars.u.username));
      qc.invalidateQueries({ queryKey: ["platform-users"] });
    },
    onError: (e: Error) => toast.error(e.message || t("pf-role-change-failed")),
  });

  const disable2faMut = useMutation({
    mutationFn: async (u: PlatformUser) => {
      const r = await fetch(`/api/users/${u.id}/disable-2fa`, {
        method: "POST",
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || t("pf-disable-2fa-failed"));
    },
    onSuccess: (_d, u) => {
      toast.success(t("pf-disable-2fa-toast").replace("{username}", u.username));
      qc.invalidateQueries({ queryKey: ["platform-users"] });
      setDisable2faTarget(null);
    },
    onError: (e: Error) => toast.error(e.message || t("pf-disable-2fa-failed")),
  });

  // Defense-in-depth: deny non-super-admins BEFORE rendering the user list.
  // Placed AFTER all hook calls (useQuery/useMemo/useMutation) to comply
  // with react-hooks/rules-of-hooks.
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

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div><CardTitle className="flex items-center gap-2 text-base"><Users className="size-4 text-primary" /> {t("pf-all-users")} <ModuleInfoTooltip title="All Users" description="Cross-tenant user management. Create, delete, reset passwords, change roles, and manage 2FA for any user." howToUse={["View all users across all tenants", "Filter by role or tenant", "Create new users", "Reset passwords", "Change roles (user/admin/super_admin)", "Disable 2FA", "Delete (type-to-confirm for admins)"]} /></CardTitle><CardDescription className="text-xs">{t("pf-users-desc")}</CardDescription></div>
            <div className="flex items-center gap-2">
              <Badge variant="outline">{filtered.length} {t("pf-of")} {items.length}</Badge>
              <Button onClick={() => setShowCreate(true)}>
                <Plus className="size-4 mr-1" /> {t("pf-create-user")}
              </Button>
            </div>
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
                {filtered.map((u) => {
                  // Don't allow self-delete, self-reset, self-2fa-disable,
                  // or self-role-change — every one of those is a
                  // self-mutation that bypasses a self-service proof
                  // (current password / TOTP). The API enforces this
                  // too (the routes reject id === auth.user.id), but
                  // hiding the button is better UX than a 400 toast.
                  const isSelf = u.id === userObj?.id;
                  return (
                    <TableRow key={u.id}>
                      <TableCell>
                        <div className="min-w-0">
                          <p className="text-sm font-medium flex items-center gap-1.5">
                            {u.username}
                            {u.totp_enabled && (
                              <span title={t("pf-2fa-active")} aria-label={t("pf-2fa-active")}>
                                <ShieldCheck className="size-3 text-emerald-600" />
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-muted-foreground truncate max-w-[200px]">{u.email}</p>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{u.tenant_id ? tenantName.get(u.tenant_id) || u.tenant_id.slice(0, 8) : <span className="text-primary font-semibold">{t("pf-platform-badge")}</span>}</TableCell>
                      <TableCell>
                        {/* Inline role change — super_admin can
                            promote/demote any user (the API enforces
                            "only super-admin can grant super_admin"). The
                            self-edit case is hidden (would let a user
                            self-promote to super_admin). */}
                        <Select
                          value={u.role}
                          onValueChange={(role) => !isSelf && changeRoleMut.mutate({ u, role })}
                          disabled={isSelf || changeRoleMut.isPending}
                        >
                          <SelectTrigger className="h-7 w-[130px] text-xs" aria-label={t("pf-change-role")}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="super_admin">{t("pf-role-super-admin")}</SelectItem>
                            <SelectItem value="admin">{t("pf-role-admin")}</SelectItem>
                            <SelectItem value="user">{t("pf-role-user")}</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
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
                          {/* Reset password — admins (incl. super_admin)
                              can reset any user's password. Hidden for
                              the operator's own row (use the self-service
                              change-password flow). */}
                          {!isSelf && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-8"
                              title={t("pf-reset-password")}
                              aria-label={t("pf-reset-password")}
                              onClick={() => setResetTarget(u)}
                            >
                              <Lock className="size-4" />
                            </Button>
                          )}
                          {/* Disable 2FA — only shown when the user has
                              2FA active. Hidden for self (use the
                              self-service /api/auth/2fa/disable which
                              requires a current-password / TOTP proof). */}
                          {!isSelf && u.totp_enabled && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-8 text-amber-600"
                              title={t("pf-disable-2fa")}
                              aria-label={t("pf-disable-2fa")}
                              onClick={() => setDisable2faTarget(u)}
                            >
                              <ShieldOff className="size-4" />
                            </Button>
                          )}
                          {/* Delete — last-super-admin + self-delete are
                              blocked by the API; hiding the button for
                              those cases is better UX than a 400 toast. */}
                          {!isSelf && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-8 text-destructive"
                              title={t("pf-delete-user")}
                              aria-label={t("pf-delete-user")}
                              onClick={() => setDeleteTarget(u)}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {editing && <PermissionEditor user={editing} tenantName={editing.tenant_id ? tenantName.get(editing.tenant_id) || editing.tenant_id : t("pf-platform-badge")} onClose={() => setEditing(null)} onSaved={() => { qc.invalidateQueries({ queryKey: ["platform-users"] }); setEditing(null); }} />}

      <CreateUserDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        tenants={tenants}
        onSaved={() => {
          setShowCreate(false);
          qc.invalidateQueries({ queryKey: ["platform-users"] });
        }}
      />

      <ResetPasswordDialog
        target={resetTarget}
        onClose={() => setResetTarget(null)}
        onConfirm={(password) => resetTarget && resetPwMut.mutate({ u: resetTarget, password })}
        saving={resetPwMut.isPending}
      />

      <Disable2faDialog
        target={disable2faTarget}
        onClose={() => setDisable2faTarget(null)}
        onConfirm={() => disable2faTarget && disable2faMut.mutate(disable2faTarget)}
        saving={disable2faMut.isPending}
      />

      <DeleteUserDialog
        target={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteMut.mutate(deleteTarget)}
        saving={deleteMut.isPending}
      />
    </div>
  );
}

// ---- Create user dialog ----
function CreateUserDialog({
  open, onOpenChange, tenants, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tenants: Tenant[];
  onSaved: () => void;
}) {
  const t = useT();
  const [username, setUsername] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [fullName, setFullName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPw, setShowPw] = React.useState(false);
  const [role, setRole] = React.useState<string>("user");
  // "" = platform (super_admin) — no tenant. Any other value = a
  // tenant_id from the list. The default is the first tenant in the
  // list (most new users go into an existing tenant; super_admin creates
  // are rare and the operator picks "" explicitly).
  const [tenantId, setTenantId] = React.useState<string>(tenants[0]?.id || "");
  const [saving, setSaving] = React.useState(false);

  // Reset the form whenever the dialog is opened (and keep the tenant
  // list in sync if the operator opens the dialog after a tenant was
  // added — fall back to the first tenant if our cached selection is
  // no longer in the list).
  React.useEffect(() => {
    if (!open) return;
// eslint-disable-next-line react-hooks/set-state-in-effect
    setUsername(""); setEmail(""); setFullName(""); setPassword("");
    setShowPw(false); setRole("user");
    setTenantId((cur) => (tenants.some((tn) => tn.id === cur) ? cur : tenants[0]?.id || ""));
  }, [open]);

  async function save() {
    if (!username.trim()) { toast.error(t("pf-username-required")); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { toast.error(t("pf-email-required")); return; }
    if (password.length < 8) { toast.error(t("pf-password-required")); return; }
    if (role !== "super_admin" && !tenantId) { toast.error(t("pf-tenant")); return; }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        username: username.trim(),
        email: email.trim(),
        full_name: fullName.trim() || null,
        password,
        role,
        active: true,
      };
      // super_admin role = platform-level (no tenant_id). Any other role
      // requires a tenant_id; super_admin creating super_admin can also
      // explicitly pick "no tenant" (the empty option) — body.tenant_id
      // stays null and the API route leaves it null.
      if (role !== "super_admin") body.tenant_id = tenantId;
      else if (tenantId) body.tenant_id = tenantId;
      const r = await fetch("/api/users", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || t("pf-create-user-failed"));
      toast.success(t("pf-create-user-toast"));
      onSaved();
    } catch (e: any) {
      toast.error(e.message || t("pf-create-user-failed"));
    } finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Plus className="size-5" /> {t("pf-create-user-title")}</DialogTitle>
          <DialogDescription>{t("pf-create-user-desc")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("pf-username")} *</Label>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="jane.doe" />
            </div>
            <div className="space-y-1.5">
              <Label>{t("pf-email")} *</Label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@example.com" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{t("pf-full-name")}</Label>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Jane Doe" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("pf-password")} *</Label>
              <div className="relative">
                <Input
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="pr-9"
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="absolute right-1 top-1/2 -translate-y-1/2 size-7"
                  onClick={() => setShowPw((v) => !v)}
                  title={showPw ? t("admin-vault-hide") : t("admin-vault-show")}
                  aria-label={showPw ? t("admin-vault-hide") : t("admin-vault-show")}
                >
                  {showPw ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t("pf-change-role")}</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">{t("pf-role-user")}</SelectItem>
                  <SelectItem value="admin">{t("pf-role-admin")}</SelectItem>
                  <SelectItem value="super_admin">{t("pf-role-super-admin")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{t("pf-tenant")}</Label>
            <Select value={tenantId} onValueChange={setTenantId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="">{t("pf-no-tenant-platform")}</SelectItem>
                {tenants.map((tn) => <SelectItem key={tn.id} value={tn.id}>{tn.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t("pf-no-tenant-platform")}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>{t("cancel")}</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="size-4 mr-2 animate-spin" />}
            {t("pf-create-user")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Reset password dialog ----
function ResetPasswordDialog({
  target, onClose, onConfirm, saving,
}: {
  target: PlatformUser | null;
  onClose: () => void;
  onConfirm: (password: string) => void;
  saving: boolean;
}) {
  const t = useT();
  const [password, setPassword] = React.useState("");
  const [showPw, setShowPw] = React.useState(false);

  React.useEffect(() => {
    if (target) {
// eslint-disable-next-line react-hooks/set-state-in-effect
      setPassword("");
      setShowPw(false);
    }
  }, [target]);

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Lock className="size-5" /> {t("pf-reset-password-title").replace("{username}", target?.username || "")}</DialogTitle>
          <DialogDescription>{t("pf-reset-password-desc")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <div className="space-y-1.5">
            <Label>{t("pf-new-password")} *</Label>
            <div className="relative">
              <Input
                type={showPw ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="pr-9"
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="absolute right-1 top-1/2 -translate-y-1/2 size-7"
                onClick={() => setShowPw((v) => !v)}
                title={showPw ? t("admin-vault-hide") : t("admin-vault-show")}
                aria-label={showPw ? t("admin-vault-hide") : t("admin-vault-show")}
              >
                {showPw ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("pf-password-required")}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>{t("cancel")}</Button>
          <Button onClick={() => onConfirm(password)} disabled={saving || password.length < 8}>
            {saving && <Loader2 className="size-4 mr-2 animate-spin" />}
            {t("pf-reset-password")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Disable 2FA confirmation ----
function Disable2faDialog({
  target, onClose, onConfirm, saving,
}: {
  target: PlatformUser | null;
  onClose: () => void;
  onConfirm: () => void;
  saving: boolean;
}) {
  const t = useT();
  return (
    <AlertDialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("pf-disable-2fa-confirm").replace("{username}", target?.username || "")}</AlertDialogTitle>
          <AlertDialogDescription>{t("pf-disable-2fa-desc")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => { e.preventDefault(); onConfirm(); }}
            disabled={saving}
            className="bg-amber-600 text-white hover:bg-amber-700"
          >
            {saving && <Loader2 className="size-4 mr-2 animate-spin" />}
            {t("pf-disable-2fa")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---- Delete user dialog (with type-to-confirm for admin/super_admin) ----
function DeleteUserDialog({
  target, onClose, onConfirm, saving,
}: {
  target: PlatformUser | null;
  onClose: () => void;
  onConfirm: () => void;
  saving: boolean;
}) {
  const t = useT();
  // Type-to-confirm for admin/super_admin targets — these are
  // high-impact deletes (an admin demotion can orphan a tenant; a
  // super_admin delete is permanent platform-owner removal). The
  // operator must type the user's email verbatim to enable the Delete
  // button. Regular users get a simple confirm (their impact is
  // bounded to themselves).
  const requiresTypeConfirm = target?.role === "admin" || target?.role === "super_admin";
  const [typedEmail, setTypedEmail] = React.useState("");

  React.useEffect(() => {
// eslint-disable-next-line react-hooks/set-state-in-effect
    if (target) setTypedEmail("");
  }, [target]);

  const canConfirm = !requiresTypeConfirm || (target && typedEmail.trim().toLowerCase() === target.email.trim().toLowerCase());

  return (
    <AlertDialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("pf-delete-confirm").replace("{username}", target?.username || "")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("pf-delete-confirm-desc")}
            {requiresTypeConfirm && (
              <span className="block mt-2 text-amber-700 dark:text-amber-400 font-medium">
                {t("pf-delete-type-confirm")}
              </span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {requiresTypeConfirm && target && (
          <div className="px-6 pb-2 space-y-1.5">
            <Input
              value={typedEmail}
              onChange={(e) => setTypedEmail(e.target.value)}
              placeholder={t("pf-delete-type-placeholder").replace("{email}", target.email)}
              aria-label={t("pf-delete-type-confirm")}
            />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => { e.preventDefault(); if (canConfirm) onConfirm(); }}
            disabled={!canConfirm || saving}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {saving && <Loader2 className="size-4 mr-2 animate-spin" />}
            {t("pf-delete-user")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
