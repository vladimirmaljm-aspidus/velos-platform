"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Building2,
  Save,
  Loader2,
  Crown,
  Shield,
  Boxes,
  Briefcase,
  Mail,
  Phone,
  User,
  MapPin,
  Hash,
  Landmark,
  FileText,
  Lock,
  Clock,
  ArrowRight,
  Eye,
  EyeOff,
  Check,
  X,
  ShieldCheck,
} from "lucide-react";
import { useAppStore } from "@/lib/store/app-store";
import { fmtDate, fmtRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useT } from "@/lib/i18n/store";
import type {
  PortalAccess,
  PortalTier,
  Partner,
  Tenant,
} from "@/lib/supabase/types";

const TIER_META: Record<
  PortalTier,
  { labelKey: string; className: string; icon: React.ComponentType<{ className?: string }> }
> = {
  premium: {
    labelKey: "portal-tier-premium",
    className: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400",
    icon: Crown,
  },
  business: {
    labelKey: "portal-tier-business",
    className: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    icon: Briefcase,
  },
  standard: {
    labelKey: "portal-tier-standard",
    className: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-400",
    icon: Shield,
  },
  basic: {
    labelKey: "portal-tier-basic",
    className: "border-transparent bg-muted text-muted-foreground",
    icon: Boxes,
  },
  limited: {
    labelKey: "portal-tier-basic",
    className: "border-transparent bg-muted text-muted-foreground",
    icon: Boxes,
  },
};

export function PortalProfile() {
  const t = useT();
  const portalAccess = useAppStore((s) => s.portalAccess) as PortalAccess | null;
  const setView = useAppStore((s) => s.setView);

  if (!portalAccess) return null;

  const canViewProfile = !!portalAccess.can_view_profile;
  const canViewCompany = !!portalAccess.can_view_company_info;

  // If user can't see either, show locked state
  if (!canViewProfile && !canViewCompany) {
    return (
      <div className="max-w-4xl mx-auto space-y-5">
        <PageHeader t={t} />
        <LockedCard label={t("portal-profile-title")} t={t} />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <PageHeader t={t} />

      {/* Two-column layout on desktop */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {canViewProfile ? (
          <ProfileColumn portalAccess={portalAccess} />
        ) : (
          <LockedCard label={t("portal-nav-my-profile")} t={t} />
        )}
        {canViewCompany ? (
          <CompanyColumn portalAccess={portalAccess} onGoProfile={() => setView("portal-messages")} />
        ) : (
          <LockedCard label={t("portal-nav-company-info")} t={t} />
        )}
      </div>

      {/* Security / Change Password section */}
      <SecuritySection />
    </div>
  );
}

function PageHeader({ t }: { t: (key: string) => string }) {
  const title = t("portal-profile-title");
  const firstSpace = title.indexOf(" ");
  const head = firstSpace === -1 ? title : title.slice(0, firstSpace);
  const tail = firstSpace === -1 ? "" : title.slice(firstSpace + 1);
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">
        {head}{tail && <span className="text-gradient-emerald"> {tail}</span>}
      </h1>
      <p className="text-sm text-muted-foreground mt-1">
        {t("portal-profile-intro")}
      </p>
    </div>
  );
}

// ---------------- My Profile column ----------------
function ProfileColumn({ portalAccess }: { portalAccess: PortalAccess }) {
  const t = useT();
  const profileQ = useQuery<{ partner: Partner; access: PortalAccess }>({
    queryKey: ["portal-profile"],
    queryFn: async () => {
      const r = await fetch("/api/portal/profile");
      if (!r.ok) throw new Error("Failed to load profile");
      return r.json();
    },
  });

  if (profileQ.isLoading) {
    return (
      <div className="card-premium p-12 flex items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const partner = profileQ.data?.partner;
  if (!partner) {
    return (
      <div className="card-premium p-12 text-center text-sm text-muted-foreground">
        {t("portal-profile-unable-load")}
      </div>
    );
  }

  // Keyed remount initializes the form from the freshly loaded partner — no effect needed.
  return <ProfileForm key={partner.id} partner={partner} portalAccess={portalAccess} />;
}

function ProfileForm({ partner, portalAccess }: { partner: Partner; portalAccess: PortalAccess }) {
  const t = useT();
  const qc = useQueryClient();
  const tier = portalAccess.tier;
  const TierIcon = TIER_META[tier].icon;
  const tierLabel = t(TIER_META[tier].labelKey);

  const [form, setForm] = useState({
    contact_name: partner.contact_name || "",
    contact_email: partner.contact_email || "",
    contact_phone: partner.contact_phone || "",
    phone: partner.phone || "",
  });

  const saveMut = useMutation({
    mutationFn: async (body: typeof form) => {
      const r = await fetch("/api/portal/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to save profile");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("portal-profile-toast-saved"));
      qc.invalidateQueries({ queryKey: ["portal-profile"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    saveMut.mutate(form);
  }

  const dirty =
    form.contact_name !== (partner.contact_name || "") ||
    form.contact_email !== (partner.contact_email || "") ||
    form.contact_phone !== (partner.contact_phone || "") ||
    form.phone !== (partner.phone || "");

  return (
    <div className="space-y-5">
      {/* Identity card — premium with avatar + tier badge */}
      <div className="card-premium p-6 relative overflow-hidden">
        {/* Decorative accent */}
        <div className="absolute top-0 right-0 h-24 w-24 bg-primary/[0.06] blur-3xl rounded-full" />
        <div className="relative">
          <h3 className="text-base font-semibold flex items-center gap-2 mb-4">
            <User className="size-4 text-primary" /> {t("portal-profile-account-overview")}
          </h3>
          <div className="flex flex-wrap items-center gap-4">
            <div className="size-16 rounded-2xl bg-gradient-to-br from-primary/15 to-primary/5 text-primary flex items-center justify-center font-semibold text-2xl shadow-soft shrink-0">
              {(partner.name || "?").charAt(0)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-semibold truncate text-base">{partner.name}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {partner.entity_type === "individual" ? t("portal-profile-individual-account") : t("portal-profile-company-account")}
                {partner.country ? ` · ${partner.country}` : ""}
              </p>
              <Badge className={cn("mt-2 gap-1", TIER_META[tier].className)}>
                <TierIcon className="size-3" />
                {t("portal-tier-label").replace("{tier}", tierLabel)}
              </Badge>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-5">
            <ReadTile label={t("portal-profile-tier")} value={tierLabel} icon={TierIcon} accent={TIER_META[tier].className} />
            <ReadTile
              label={t("portal-profile-entity-type")}
              value={partner.entity_type === "individual" ? t("portal-individual") : t("portal-company")}
              icon={Building2}
            />
          </div>
          {portalAccess.last_login_at && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-4">
              <Clock className="size-3.5" />
              {portalAccess.last_login_ip
                ? t("portal-last-login-from")
                    .replace("{relative}", fmtRelative(portalAccess.last_login_at))
                    .replace("{ip}", portalAccess.last_login_ip)
                : `${t("portal-last-login")} ${fmtRelative(portalAccess.last_login_at)}`}
            </div>
          )}
        </div>
      </div>

      {/* Editable contact info */}
      <form onSubmit={submit} className="card-premium p-6 space-y-5">
        <div>
          <h3 className="text-base font-semibold flex items-center gap-2">
            <Mail className="size-4 text-primary" /> {t("portal-profile-contact-info")}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("portal-profile-contact-info-desc")}
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label={t("portal-profile-contact-name")} icon={User}>
            <Input
              value={form.contact_name}
              onChange={(e) => setForm({ ...form, contact_name: e.target.value })}
              placeholder={t("portal-profile-your-name-placeholder")}
              className="h-10 smooth focus-visible:ring-primary/40 focus-visible:border-primary/40"
            />
          </Field>
          <Field label={t("portal-profile-contact-email")} icon={Mail}>
            <Input
              type="email"
              value={form.contact_email}
              onChange={(e) => setForm({ ...form, contact_email: e.target.value })}
              placeholder="you@company.com"
              className="h-10 smooth focus-visible:ring-primary/40 focus-visible:border-primary/40"
            />
          </Field>
          <Field label={t("portal-profile-contact-phone")} icon={Phone}>
            <Input
              value={form.contact_phone}
              onChange={(e) => setForm({ ...form, contact_phone: e.target.value })}
              placeholder="+381 …"
              className="h-10 smooth focus-visible:ring-primary/40 focus-visible:border-primary/40"
            />
          </Field>
          <Field label={t("portal-profile-company-phone")} icon={Phone}>
            <Input
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              placeholder="+381 …"
              className="h-10 smooth focus-visible:ring-primary/40 focus-visible:border-primary/40"
            />
          </Field>
        </div>
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/60">
          <Button
            type="submit"
            disabled={saveMut.isPending || !dirty}
            className="smooth hover:shadow-soft-md"
          >
            {saveMut.isPending ? (
              <Loader2 className="size-4 animate-spin mr-1.5" />
            ) : (
              <Save className="size-4 mr-1.5" />
            )}
            {t("portal-action-save-changes")}
          </Button>
        </div>
      </form>
    </div>
  );
}

// ---------------- Company Info column ----------------
function CompanyColumn({
  portalAccess,
  onGoProfile,
}: {
  portalAccess: PortalAccess;
  onGoProfile: () => void;
}) {
  const t = useT();
  const companyQ = useQuery<{ tenant: Tenant }>({
    queryKey: ["portal-company"],
    queryFn: async () => {
      const r = await fetch("/api/portal/company");
      if (!r.ok) throw new Error("Failed to load company info");
      return r.json();
    },
  });

  if (companyQ.isLoading) {
    return (
      <div className="card-premium p-12 flex items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const tenant = companyQ.data?.tenant;
  if (!tenant) {
    return (
      <div className="card-premium p-12 text-center text-sm text-muted-foreground">
        {t("portal-profile-unable-load-company")}
      </div>
    );
  }

  const tier = portalAccess.tier;
  const showBasic = tier === "premium" || tier === "standard";
  const showFull = tier === "premium";
  const tierLabel = t(TIER_META[tier].labelKey);

  return (
    <div className="card-premium p-6 relative overflow-hidden">
      {/* Glass effect — subtle layered background */}
      <div className="absolute inset-0 bg-mesh-portal opacity-30 pointer-events-none" />

      {/* Premium ribbon */}
      {tier === "premium" && (
        <div className="absolute top-0 right-0">
          <div className="bg-gradient-emerald text-primary-foreground text-[10px] font-semibold uppercase tracking-wider px-3 py-1 rounded-bl-lg flex items-center gap-1 shadow-soft">
            <Crown className="size-3" /> {t("portal-profile-premium")}
          </div>
        </div>
      )}

      <div className="relative space-y-5">
        <div className="flex items-start gap-3">
          <div className="size-11 rounded-xl bg-gradient-to-br from-primary/15 to-primary/5 flex items-center justify-center shrink-0">
            <Building2 className="size-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold truncate">
              {tenant.legal_name || tenant.name}
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("portal-profile-firm-serving")}
            </p>
            <Badge className={cn("mt-2 gap-1", TIER_META[tier].className)}>
              {t("portal-tier-access").replace("{tier}", tierLabel)}
            </Badge>
          </div>
        </div>

        {/* Basic identity */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <InfoRow icon={Building2} label={t("portal-profile-legal-name")} value={tenant.legal_name || tenant.name} />
          <InfoRow icon={MapPin} label={t("portal-kyc-country")} value={tenant.country || "—"} />
          {showBasic && (
            <>
              <InfoRow icon={Hash} label={t("portal-kyc-tax-id")} value={tenant.tax_id || "—"} mono />
              {tenant.vat_number && (
                <InfoRow icon={FileText} label={t("portal-profile-vat-number")} value={tenant.vat_number} mono />
              )}
              {tenant.registration_number && (
                <InfoRow
                  icon={FileText}
                  label={t("portal-profile-registration-no")}
                  value={tenant.registration_number}
                  mono
                />
              )}
            </>
          )}
        </div>

        {/* Limited tier notice */}
        {!showBasic && (
          <UpgradeNotice
            title={t("portal-profile-limited-title")}
            description={t("portal-profile-limited-desc").replace("{tier}", tierLabel)}
          />
        )}

        {/* Address (standard + premium) */}
        {showBasic && (tenant.address_line || tenant.city) && (
          <>
            <Separator />
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                {t("portal-profile-address")}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <InfoRow icon={MapPin} label={t("portal-profile-street")} value={tenant.address_line || "—"} />
                <InfoRow
                  icon={MapPin}
                  label={t("portal-profile-city")}
                  value={[tenant.postal_code, tenant.city].filter(Boolean).join(" ") || "—"}
                />
              </div>
            </div>
          </>
        )}

        {/* Bank details (premium only) */}
        {showFull && (tenant.bank_name || tenant.bank_iban) && (
          <>
            <Separator />
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t("portal-profile-bank-details")}
                </p>
                <Badge className="gap-1 border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400">
                  <Crown className="size-3" /> {t("portal-profile-premium")}
                </Badge>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <InfoRow icon={Landmark} label={t("portal-profile-bank")} value={tenant.bank_name || "—"} />
                <InfoRow icon={Landmark} label={t("portal-profile-iban")} value={tenant.bank_iban || "—"} mono />
                <InfoRow icon={Hash} label={t("portal-profile-swift-bic")} value={tenant.bank_swift || "—"} mono />
                <InfoRow icon={Building2} label={t("portal-profile-bank-currency")} value={tenant.currency || "—"} />
              </div>
            </div>
          </>
        )}

        {/* Standard tier upgrade hint */}
        {tier === "standard" && (
          <UpgradeNotice
            title={t("portal-profile-upgrade-bank-title")}
            description={t("portal-profile-upgrade-bank-desc")}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={onGoProfile}
                className="mt-2 smooth hover:shadow-soft"
              >
                {t("portal-profile-contact-us")} <ArrowRight className="size-3.5 ml-1" />
              </Button>
            }
          />
        )}

        <Separator />
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{t("portal-member-since").replace("{date}", fmtDate(tenant.created_at))}</span>
          <span className="capitalize">{t("portal-plan-label").replace("{plan}", tenant.plan || "")}</span>
        </div>
      </div>
    </div>
  );
}

// ---------------- Small helpers ----------------
function Field({
  label,
  icon: Icon,
  children,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
        <Icon className="size-3.5" />
        {label}
      </Label>
      {children}
    </div>
  );
}

function ReadTile({
  label,
  value,
  icon: Icon,
  accent,
  mono,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  accent?: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Icon className="size-3" />
        {label}
      </div>
      {accent ? (
        <Badge className={cn("mt-1.5 text-[11px]", accent)}>{value}</Badge>
      ) : (
        <p className={cn("text-sm font-medium mt-1 truncate", mono && "font-mono tabular")}>
          {value}
        </p>
      )}
    </div>
  );
}

function InfoRow({
  icon: Icon,
  label,
  value,
  mono,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="size-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
        <Icon className="size-4 text-primary" />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] text-muted-foreground">{label}</p>
        <p className={cn("text-sm font-medium truncate", mono && "font-mono tabular")}>{value}</p>
      </div>
    </div>
  );
}

function UpgradeNotice({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border/60 bg-muted/30 p-4 flex items-start gap-2.5">
      <div className="size-9 rounded-lg bg-amber-500/15 text-amber-700 dark:text-amber-400 flex items-center justify-center shrink-0">
        <Lock className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        {action}
      </div>
    </div>
  );
}

function LockedCard({ label, t }: { label: string; t: (key: string) => string }) {
  return (
    <div className="card-premium p-12 flex flex-col items-center justify-center text-center">
      <div className="size-14 rounded-full bg-gradient-to-br from-muted to-muted/50 flex items-center justify-center mb-3">
        <Lock className="size-6 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">{t("portal-locked-card-label").replace("{label}", label)}</p>
      <p className="text-xs text-muted-foreground mt-1 max-w-sm">
        {t("portal-locked-card-desc")}
      </p>
    </div>
  );
}

// ---------------- Security / Change Password section ----------------
function SecuritySection() {
  const t = useT();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  // Password strength checks
  const hasMinLength = newPassword.length >= 8;
  const hasUppercase = /[A-Z]/.test(newPassword);
  const hasLowercase = /[a-z]/.test(newPassword);
  const hasNumber = /[0-9]/.test(newPassword);
  const allRulesMet = hasMinLength && hasUppercase && hasLowercase && hasNumber;
  const passwordsMatch = newPassword === confirmPassword && confirmPassword.length > 0;
  const canSubmit = currentPassword.length > 0 && allRulesMet && passwordsMatch;

  // Strength bar calculation
  const rulesPassed = [hasMinLength, hasUppercase, hasLowercase, hasNumber].filter(Boolean).length;
  const strengthPercent = (rulesPassed / 4) * 100;
  const strengthColor =
    rulesPassed <= 1 ? "bg-red-500" :
    rulesPassed === 2 ? "bg-amber-500" :
    rulesPassed === 3 ? "bg-yellow-500" :
    "bg-emerald-500";
  const strengthLabel =
    rulesPassed <= 1 ? t("portal-profile-strength-weak") :
    rulesPassed === 2 ? t("portal-profile-strength-fair") :
    rulesPassed === 3 ? t("portal-profile-strength-good") :
    t("portal-profile-strength-strong");

  const changePwMut = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/portal/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
          confirm_password: confirmPassword,
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        throw new Error(data.error || t("portal-profile-toast-password-failed"));
      }
      return data;
    },
    onSuccess: () => {
      toast.success(t("portal-profile-toast-password-changed"));
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    changePwMut.mutate();
  }

  return (
    <div className="card-premium p-6">
      <div className="flex items-center gap-2 mb-1">
        <div className="size-8 rounded-lg bg-primary/10 flex items-center justify-center">
          <ShieldCheck className="size-4 text-primary" />
        </div>
        <h3 className="text-base font-semibold">{t("portal-profile-security")}</h3>
      </div>
      <p className="text-xs text-muted-foreground mb-5 ml-10">
        {t("portal-profile-security-desc")}
      </p>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {/* Current Password */}
          <Field label={t("portal-profile-current-password")} icon={Lock}>
            <div className="relative">
              <Input
                type={showCurrent ? "text" : "password"}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder={t("portal-profile-enter-current")}
                className="h-10 pr-10 smooth focus-visible:ring-primary/40 focus-visible:border-primary/40"
                autoComplete="current-password"
              />
              <button
                type="button"
                tabIndex={-1}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setShowCurrent(!showCurrent)}
              >
                {showCurrent ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </Field>

          {/* New Password */}
          <Field label={t("portal-profile-new-password")} icon={Lock}>
            <div className="relative">
              <Input
                type={showNew ? "text" : "password"}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder={t("portal-profile-enter-new")}
                className="h-10 pr-10 smooth focus-visible:ring-primary/40 focus-visible:border-primary/40"
                autoComplete="new-password"
              />
              <button
                type="button"
                tabIndex={-1}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setShowNew(!showNew)}
              >
                {showNew ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </Field>

          {/* Confirm Password */}
          <Field label={t("portal-profile-confirm-password")} icon={Lock}>
            <div className="relative">
              <Input
                type={showConfirm ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder={t("portal-profile-reenter-new")}
                className="h-10 pr-10 smooth focus-visible:ring-primary/40 focus-visible:border-primary/40"
                autoComplete="new-password"
              />
              <button
                type="button"
                tabIndex={-1}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setShowConfirm(!showConfirm)}
              >
                {showConfirm ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            {confirmPassword.length > 0 && !passwordsMatch && (
              <p className="text-xs text-destructive mt-1">{t("portal-profile-passwords-no-match")}</p>
            )}
          </Field>
        </div>

        {/* Password strength indicator */}
        {newPassword.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className={cn("h-full rounded-full transition-all duration-300", strengthColor)}
                  style={{ width: `${strengthPercent}%` }}
                />
              </div>
              <span className="text-xs font-medium text-muted-foreground min-w-[3rem] text-right">
                {strengthLabel}
              </span>
            </div>

            {/* Password requirements */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1">
              <RequirementMet label={t("portal-profile-req-8-chars")} met={hasMinLength} />
              <RequirementMet label={t("portal-profile-req-uppercase")} met={hasUppercase} />
              <RequirementMet label={t("portal-profile-req-lowercase")} met={hasLowercase} />
              <RequirementMet label={t("portal-profile-req-number")} met={hasNumber} />
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/60">
          <Button
            type="submit"
            disabled={!canSubmit || changePwMut.isPending}
            className="smooth hover:shadow-soft-md"
          >
            {changePwMut.isPending ? (
              <Loader2 className="size-4 animate-spin mr-1.5" />
            ) : (
              <ShieldCheck className="size-4 mr-1.5" />
            )}
            {t("portal-profile-change-password")}
          </Button>
        </div>
      </form>
    </div>
  );
}

function RequirementMet({ label, met }: { label: string; met: boolean }) {
  return (
    <div className={cn("flex items-center gap-1.5 text-xs transition-colors", met ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
      {met ? (
        <Check className="size-3.5 shrink-0" />
      ) : (
        <X className="size-3.5 shrink-0" />
      )}
      {label}
    </div>
  );
}
