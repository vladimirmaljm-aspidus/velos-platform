"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card, CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Textarea } from "@/components/ui/textarea";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Pagination, PaginationContent, PaginationItem, PaginationPrevious, PaginationNext,
} from "@/components/ui/pagination";
import { Plus, Pencil, Trash2, Users as UsersIcon, ShieldAlert, ChevronDown, Wand2, Eye, EyeOff, Copy, Check, Building2, UserCheck } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { PermissionTree } from "@/components/common/permission-tree";
import { fmtRelative } from "@/lib/utils/format";
import { useAppStore, isAdmin, isSuperAdmin, SafeUser } from "@/lib/store/app-store";
import { UserRole, Tenant } from "@/lib/supabase/types";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useT } from "@/lib/i18n/store";

// i18n keys for role labels & descriptions — resolved via t() at render time.
const ROLE_LABEL: Record<UserRole, string> = {
  super_admin: "admin-users-role-super-admin", admin: "admin-users-role-admin", user: "admin-users-role-user",
};

const ROLE_DESCRIPTION: Record<UserRole, string> = {
  super_admin: "admin-users-role-super-admin-desc",
  admin: "admin-users-role-admin-desc",
  user: "admin-users-role-user-desc",
};

const ROLE_BADGE: Record<UserRole, string> = {
  super_admin: "border-transparent bg-destructive text-destructive-foreground",
  admin: "border-transparent bg-primary text-primary-foreground",
  user: "border-transparent bg-secondary text-secondary-foreground",
};

function initials(name?: string | null): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function generatePassword(): string {
  const letters = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
  const numbers = "23456789";
  const all = letters + numbers;
  let pwd = "";
  // Ensure at least 1 letter and 1 number
  pwd += letters[Math.floor(Math.random() * letters.length)];
  pwd += numbers[Math.floor(Math.random() * numbers.length)];
  for (let i = 2; i < 8; i++) {
    pwd += all[Math.floor(Math.random() * all.length)];
  }
  // Shuffle
  return pwd.split("").sort(() => Math.random() - 0.5).join("");
}

const PAGE_SIZE = 20;

export function UsersView() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const qc = useQueryClient();
  const currentUser = useAppStore((s) => s.user);
  const admin = isAdmin(currentUser);
  const [editing, setEditing] = useState<SafeUser | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ["users", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/users"));
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to load users");
      }
      return r.json() as Promise<{ items: SafeUser[] }>;
    },
    enabled: admin,
  });

  // Fetch tenants for linking
  const { data: tenantsData } = useQuery({
    queryKey: ["tenants", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/tenants"));
      if (!r.ok) throw new Error("Failed to load tenants");
      return r.json() as Promise<{ items: Tenant[] }>;
    },
    enabled: admin,
  });

  const tenants = tenantsData?.items || [];
  const tenantMap = new Map<string, string>();
  tenants.forEach((t) => tenantMap.set(t.id, t.name));

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(api(`/api/users/${id}`), { method: "DELETE" });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to delete user");
      }
    },
    onSuccess: () => {
      toast.success("User deleted.");
      qc.invalidateQueries({ queryKey: ["users", tenantKey] });
      setDeleteId(null);
    },
    onError: (e: any) => toast.error(e.message || "Failed to delete user."),
  });

  const allItems = data?.items || [];
  const totalPages = Math.max(1, Math.ceil(allItems.length / PAGE_SIZE));
  const effectivePage = Math.min(page, totalPages);
  const items = allItems.slice((effectivePage - 1) * PAGE_SIZE, effectivePage * PAGE_SIZE);

  const handleToggleActive = async (userId: string, active: boolean) => {
    try {
      const res = await fetch(api(`/api/users/${userId}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      });
      if (!res.ok) throw new Error("Failed to update");
      toast.success(active ? "User activated" : "User deactivated");
      qc.invalidateQueries({ queryKey: ["users", tenantKey] });
    } catch {
      toast.error("Failed to update user status");
    }
  };

  return (
    <div>
      <PageHeader
        title={t("users")}
        description={`${allItems.length} ${t("admin-users-total")}`}
        actions={
          <Button onClick={() => { setEditing(null); setShowForm(true); }} disabled={!admin}>
            <Plus className="size-4 mr-1" /> {t("admin-users-new")}
          </Button>
        }
      />

      {!admin && (
        <Card className="mb-4 border-amber-500/40 bg-amber-50/50 dark:bg-amber-950/20 rounded-xl">
          <CardContent className="p-4 flex items-center gap-3">
            <ShieldAlert className="size-5 text-amber-600 shrink-0" />
            <p className="text-sm text-amber-800 dark:text-amber-300">
              {t("admin-users-admin-required")}
            </p>
          </CardContent>
        </Card>
      )}

      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : !admin ? (
            <EmptyState
              icon={<UsersIcon className="size-6" />}
              title={t("admin-users-no-access-title")}
              description={t("admin-users-no-access-desc")}
            />
          ) : allItems.length === 0 ? (
            <EmptyState
              icon={<UsersIcon className="size-6" />}
              title={t("admin-users-empty-title")}
              description={t("admin-users-empty-desc")}
              action={<Button onClick={() => { setEditing(null); setShowForm(true); }}><Plus className="size-4 mr-1" /> {t("admin-users-new")}</Button>}
            />
          ) : (
            <div className="overflow-y-auto custom-scroll">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    <TableHead>{t("admin-col-user")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("admin-col-email")}</TableHead>
                    <TableHead>{t("admin-col-tenant")}</TableHead>
                    <TableHead>{t("admin-col-role")}</TableHead>
                    <TableHead>{t("admin-col-status")}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t("admin-col-last-login")}</TableHead>
                    <TableHead className="text-right">{t("admin-col-actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((u) => {
                    const isSelf = u.id === currentUser?.id;
                    return (
                      <TableRow key={u.id}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Avatar className="size-8">
                              <AvatarFallback className="text-xs">{initials(u.full_name || u.username)}</AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                              <p className="text-sm font-medium truncate">{u.username}</p>
                              <p className="text-xs text-muted-foreground truncate">{u.full_name || "—"}</p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-sm">{u.email || "—"}</TableCell>
                        <TableCell className="text-sm">
                          <div className="flex items-center gap-1.5">
                            <Building2 className="size-3.5 text-muted-foreground shrink-0" />
                            <span className="truncate">{u.tenant_id ? (tenantMap.get(u.tenant_id) || u.tenant_id.slice(0, 8)) : "—"}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={u.role === "viewer" ? "outline" : "default"} className={ROLE_BADGE[u.role as UserRole] || ""}>
                            {t(ROLE_LABEL[u.role as UserRole] || u.role)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Switch checked={!!u.active} onCheckedChange={(v) => handleToggleActive(u.id, v)} aria-label={`${t("admin-users-form-active")} ${u.full_name || u.email}`} />
                        </TableCell>
                        <TableCell className="hidden lg:table-cell text-sm text-muted-foreground">
                          {fmtRelative((u as SafeUser & { last_login_at?: string | null }).last_login_at ?? null)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            {isSuperAdmin(currentUser) && !isSelf && u.role !== "super_admin" && u.active && (
                              <Button
                                size="icon"
                                variant="ghost"
                                className="size-8 text-amber-600 hover:text-amber-700"
                                title={`${t("admin-users-impersonate-title")} ${u.username}`}
                                onClick={async () => {
                                  if (!confirm(`${t("admin-users-impersonate-confirm")} ${u.username}? ${t("admin-users-impersonate-audit")}`)) return;
                                  try {
                                    const r = await fetch("/api/super-admin/impersonate", {
                                      method: "POST",
                                      headers: { "Content-Type": "application/json" },
                                      body: JSON.stringify({ user_id: u.id, tenant_id: u.tenant_id, duration_minutes: 60 }),
                                    });
                                    if (!r.ok) {
                                      const e = await r.json().catch(() => ({}));
                                      toast.error(e.error || "Failed to start impersonation.");
                                      return;
                                    }
                                    toast.success(`${t("admin-users-impersonate-confirm")} ${u.username}.`);
                                    setTimeout(() => window.location.reload(), 400);
                                  } catch {
                                    toast.error("Failed to start impersonation.");
                                  }
                                }}
                              >
                                <UserCheck className="size-4" />
                              </Button>
                            )}
                            <Button size="icon" variant="ghost" className="size-8" onClick={() => { setEditing(u); setShowForm(true); }} title={t("edit")} aria-label={t("edit")}>
                              <Pencil className="size-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-8 text-destructive"
                              disabled={isSelf}
                              onClick={() => {
                                if (isSelf) {
                                  toast.error(t("admin-users-cannot-delete-self"));
                                  return;
                                }
                                setDeleteId(u.id);
                              }}
                              title={isSelf ? t("admin-users-cannot-delete-self") : t("delete")}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex justify-center">
          <Pagination>
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className={page <= 1 ? "pointer-events-none opacity-50" : "cursor-pointer"}
                />
              </PaginationItem>
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                <PaginationItem key={p}>
                  <Button
                    variant={p === page ? "default" : "outline"}
                    size="icon"
                    className="size-8"
                    onClick={() => setPage(p)}
                  >
                    {p}
                  </Button>
                </PaginationItem>
              ))}
              <PaginationItem>
                <PaginationNext
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className={page >= totalPages ? "pointer-events-none opacity-50" : "cursor-pointer"}
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
      )}

      <UserFormDialog
        open={showForm}
        onOpenChange={setShowForm}
        user={editing}
        tenants={tenants}
        onSaved={() => {
          setShowForm(false);
          qc.invalidateQueries({ queryKey: ["users", tenantKey] });
        }}
      />

      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("admin-users-delete-title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("admin-users-delete-desc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteId && deleteMut.mutate(deleteId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type UserForm = {
  username: string;
  email: string;
  full_name: string;
  role: UserRole;
  tenant_id: string;
  password: string;
  active: boolean;
  permissions: string[] | null;
};

function UserFormDialog({
  open, onOpenChange, user, tenants, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  user: SafeUser | null;
  tenants: Tenant[];
  onSaved: () => void;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const currentUser = useAppStore((s) => s.user);
  const isSA = isSuperAdmin(currentUser);

  const [form, setForm] = useState<UserForm>({
    username: "", email: "", full_name: "", role: "user", tenant_id: "", password: "", active: true, permissions: null,
  });
  const [saving, setSaving] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [copied, setCopied] = useState(false);
  const [usernameManuallyEdited, setUsernameManuallyEdited] = useState(false);
  const [createdPassword, setCreatedPassword] = useState<string | null>(null);

  // Whether the existing user has custom permissions (non-empty)
  const hasCustomPermissions = !!(user?.permissions && user.permissions.length > 0);

  // Fix: useMemo → useEffect for form initialization side effects
  useEffect(() => {
    if (open) {
      const defaultTenantId = isSA
        ? (tenants[0]?.id || "")
        : (currentUser?.tenant_id || "");

      setForm({
        username: user?.username || "",
        email: user?.email || "",
        full_name: user?.full_name || "",
        role: (user?.role as UserRole) || "user",
        tenant_id: user?.tenant_id || defaultTenantId,
        password: "",
        active: user?.active ?? true,
        // New users start with a baseline "dashboard.read" grant so they land
        // on a working (if mostly empty) dashboard instead of a 403 wall —
        // everything else still requires the admin to grant it explicitly.
        permissions: user ? user.permissions || null : ["dashboard.read"],
      });
      setAdvancedOpen(!!(user?.permissions && user.permissions.length > 0));
      setShowPassword(false);
      setCopied(false);
      setUsernameManuallyEdited(false);
      setCreatedPassword(null);
    }
  }, [open, user, tenants, isSA, currentUser?.tenant_id]);

  function set<K extends keyof UserForm>(k: K, v: UserForm[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function handleEmailChange(email: string) {
    set("email", email);
    if (!usernameManuallyEdited) {
      const username = email.split("@")[0] || "";
      set("username", username);
    }
  }

  function handleUsernameChange(username: string) {
    set("username", username);
    setUsernameManuallyEdited(true);
  }

  function handleGeneratePassword() {
    const pwd = generatePassword();
    set("password", pwd);
    setShowPassword(true);
    setCopied(false);
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  }

  async function save() {
    if (!form.email.trim()) { toast.error("Please enter an email."); return; }
    if (!user && !form.password) { toast.error("Please enter or generate a password."); return; }
    if (!form.tenant_id) { toast.error("Please select a tenant."); return; }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        username: form.username.trim() || form.email.trim().split("@")[0],
        email: form.email.trim(),
        full_name: form.full_name.trim() || null,
        role: form.role,
        tenant_id: form.tenant_id,
        active: form.active,
      };

      // Permissions: send the array as-is (null means "use role defaults")
      body.permissions =
        form.permissions && form.permissions.length > 0 ? form.permissions : null;

      if (form.password) body.password = form.password;

      const method = user ? "PUT" : "POST";
      const url = user ? api(`/api/users/${user.id}`) : api("/api/users");
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to save user");
      }

      if (user) {
        toast.success("User updated.");
      } else {
        // Show password in the dialog instead of toast
        setCreatedPassword(form.password);
        toast.success("User created successfully!");
      }
      onSaved();
    } catch (e: any) {
      toast.error(e.message || "Failed to save user.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="max-h-[85vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle>{user ? t("admin-users-form-title-edit") : t("admin-users-form-title-new")}</DialogTitle>
          <DialogDescription>
            {user ? t("admin-users-form-desc-edit") : t("admin-users-form-desc-new")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
          {/* Show created password info after successful creation */}
          {createdPassword && (
            <div className="p-3 rounded-lg border border-green-200 bg-green-50 dark:bg-green-950/20 dark:border-green-800 space-y-2">
            <p className="text-sm font-medium text-green-800 dark:text-green-300">{t("admin-users-created-title")}</p>
            <div className="space-y-1 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">{t("admin-users-username-label")}</span>
                <code className="font-mono">{form.username.trim()}</code>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">{t("admin-users-password-label")}</span>
                <code className="font-mono flex-1 break-all">{createdPassword}</code>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  onClick={() => copyToClipboard(createdPassword)}
                  title={t("admin-users-form-copy-password")} aria-label={t("admin-users-form-copy-password")}
                >
                  {copied ? <Check className="size-3.5 text-green-600" /> : <Copy className="size-3.5 text-muted-foreground" />}
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t("admin-users-created-help")}</p>
          </div>
        )}

        <div className="space-y-4 pt-2">

            {/* Full Name — first field */}
            <div className="space-y-1.5">
              <Label htmlFor="full_name">{t("admin-users-form-full-name")}</Label>
              <Input
                id="full_name"
                value={form.full_name}
                onChange={(e) => set("full_name", e.target.value)}
                placeholder="John Doe"
              />
            </div>

            {/* Email — auto-generates username */}
            <div className="space-y-1.5">
              <Label htmlFor="email">{t("admin-users-form-email")}</Label>
              <Input
                id="email"
                type="email"
                value={form.email}
                onChange={(e) => handleEmailChange(e.target.value)}
                placeholder="name@company.com"
              />
            </div>

            {/* Role — with descriptions */}
            <div className="space-y-1.5">
              <Label htmlFor="role">{t("admin-users-form-role")}</Label>
              <Select value={form.role} onValueChange={(v) => set("role", v as UserRole)}>
                <SelectTrigger id="role"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(["super_admin", "admin", "user"] as UserRole[]).filter((r) => isSA || r !== "super_admin").map((role) => (
                    <SelectItem key={role} value={role}>
                      <div className="flex flex-col">
                        <span className="font-medium">{t(ROLE_LABEL[role])}</span>
                        <span className="text-xs text-muted-foreground">{t(ROLE_DESCRIPTION[role])}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t(ROLE_DESCRIPTION[form.role as UserRole] || "")}</p>
            </div>

            {/* Tenant — dropdown */}
            <div className="space-y-1.5">
              <Label htmlFor="tenant_id">{t("admin-users-form-tenant")}</Label>
              {isSA ? (
                <Select value={form.tenant_id} onValueChange={(v) => set("tenant_id", v)}>
                  <SelectTrigger id="tenant_id"><SelectValue placeholder={t("admin-users-form-select-tenant")} /></SelectTrigger>
                  <SelectContent>
                    {tenants.map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={tenants.find((t) => t.id === form.tenant_id)?.name || form.tenant_id}
                  disabled
                  className="bg-muted"
                />
              )}
              <p className="text-xs text-muted-foreground">
                {isSA ? t("admin-users-form-tenant-super-help") : t("admin-users-form-tenant-help")}
              </p>
            </div>

            {/* Password — auto-generated with copy button */}
            {!user && (
              <div className="space-y-1.5">
                <Label htmlFor="password">{t("admin-users-form-password")}</Label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      value={form.password}
                      onChange={(e) => set("password", e.target.value)}
                      placeholder="••••••••"
                      className="pr-9"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-0 top-0 h-full px-2 hover:bg-transparent"
                      onClick={() => setShowPassword(!showPassword)}
                      title={showPassword ? t("admin-users-form-hide-password") : t("admin-users-form-show-password")}
                    >
                      {showPassword ? <EyeOff className="size-4 text-muted-foreground" /> : <Eye className="size-4 text-muted-foreground" />}
                    </Button>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleGeneratePassword}
                    title={t("admin-users-form-generate-help")}
                  >
                    <Wand2 className="size-4 mr-1" />
                    {t("admin-users-form-generate")}
                  </Button>
                </div>
                {form.password && showPassword && (
                  <div className="flex items-center gap-2 mt-1.5 p-2 bg-muted/50 rounded-md border">
                    <code className="text-sm font-mono flex-1 break-all">{form.password}</code>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0"
                      onClick={() => copyToClipboard(form.password)}
                      title={t("admin-users-form-copy-password")} aria-label={t("admin-users-form-copy-password")}
                    >
                      {copied ? <Check className="size-3.5 text-green-600" /> : <Copy className="size-3.5 text-muted-foreground" />}
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Password for editing — only shown if user wants to change it */}
            {user && (
              <div className="space-y-1.5">
                <Label htmlFor="password">{t("admin-users-form-new-password")} <span className="text-muted-foreground font-normal">{t("admin-users-form-new-password-hint")}</span></Label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      value={form.password}
                      onChange={(e) => set("password", e.target.value)}
                      placeholder="••••••••"
                      className="pr-9"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-0 top-0 h-full px-2 hover:bg-transparent"
                      onClick={() => setShowPassword(!showPassword)}
                      title={showPassword ? t("admin-users-form-hide-password") : t("admin-users-form-show-password")}
                    >
                      {showPassword ? <EyeOff className="size-4 text-muted-foreground" /> : <Eye className="size-4 text-muted-foreground" />}
                    </Button>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleGeneratePassword}
                    title={t("admin-users-form-generate-help")}
                  >
                    <Wand2 className="size-4 mr-1" />
                    {t("admin-users-form-generate")}
                  </Button>
                </div>
                {form.password && showPassword && (
                  <div className="flex items-center gap-2 mt-1.5 p-2 bg-muted/50 rounded-md border">
                    <code className="text-sm font-mono flex-1 break-all">{form.password}</code>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0"
                      onClick={() => copyToClipboard(form.password)}
                      title={t("admin-users-form-copy-password")} aria-label={t("admin-users-form-copy-password")}
                    >
                      {copied ? <Check className="size-3.5 text-green-600" /> : <Copy className="size-3.5 text-muted-foreground" />}
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Advanced settings — collapsible */}
            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" className="w-full flex items-center justify-between px-0 hover:bg-transparent">
                  <span className="text-sm font-medium text-muted-foreground">{t("admin-users-form-advanced")}</span>
                  <ChevronDown className={`size-4 text-muted-foreground transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="space-y-4 pt-2">

                  {/* Username — auto-filled from email */}
                  <div className="space-y-1.5">
                    <Label htmlFor="username">{t("admin-users-form-username")}</Label>
                    <Input
                      id="username"
                      value={form.username}
                      onChange={(e) => handleUsernameChange(e.target.value)}
                      placeholder="jdoe"
                    />
                    <p className="text-xs text-muted-foreground">{t("admin-users-form-username-help")}</p>
                  </div>

                  {/* Active toggle */}
                  <div className="flex items-center justify-between p-3 rounded-md bg-muted/30">
                    <div>
                      <p className="text-sm font-medium">{t("admin-users-form-active")}</p>
                      <p className="text-xs text-muted-foreground">{t("admin-users-form-active-desc")}</p>
                    </div>
                    <Switch checked={form.active} onCheckedChange={(v) => set("active", v)} aria-label={t("admin-users-form-active")} />
                  </div>

                  {/* Permissions — granular checkbox tree */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>{t("admin-users-form-custom-permissions")}</Label>
                      <span className="text-xs text-muted-foreground">
                        {t("admin-users-form-permissions-hint")}
                      </span>
                    </div>
                    <PermissionTree
                      value={form.permissions}
                      onChange={(v) => set("permissions", v as string[] | null)}
                    />
                  </div>

                </div>
              </CollapsibleContent>
            </Collapsible>

          </div>
        </div>

        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? t("admin-saving") : user ? t("admin-users-form-save-changes") : t("admin-users-form-create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
