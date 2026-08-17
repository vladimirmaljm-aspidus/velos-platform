"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppStore, isSuperAdmin, useHydrateActiveTenant } from "@/lib/store/app-store";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Badge } from "@/components/ui/badge";
import { Building2, ChevronsUpDown, Check, Search, Globe, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useT } from "@/lib/i18n/store";

interface Tenant {
  id: string;
  name: string;
  country?: string | null;
  plan?: string | null;
  status?: string | null;
  currency?: string | null;
}

export function TenantContextSwitcher() {
  const user = useAppStore((s) => s.user);
  const activeTenantId = useAppStore((s) => s.activeTenantId);
  const activeTenantName = useAppStore((s) => s.activeTenantName);
  const setActiveTenant = useAppStore((s) => s.setActiveTenant);
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const t = useT();

  // Hydrate active tenant from localStorage on mount (avoids SSR mismatch)
  useHydrateActiveTenant();

  // Fetch tenants list (super-admin only)
  const tenantsQ = useQuery({
    queryKey: ["tenants"],
    queryFn: async () => {
      const r = await fetch("/api/tenants");
      if (!r.ok) throw new Error("Failed to load tenants");
      const data = await r.json();
      return (data.items || []) as Tenant[];
    },
    enabled: isSuperAdmin(user),
  });

  // For regular users, fetch their own tenant info
  const myTenantQ = useQuery({
    queryKey: ["my-tenant", user?.tenant_id],
    queryFn: async () => {
      if (!user?.tenant_id) return null;
      const r = await fetch(`/api/tenants`);
      if (!r.ok) return null;
      const data = await r.json();
      const items = (data.items || []) as Tenant[];
      return items.find((t) => t.id === user.tenant_id) || null;
    },
    enabled: !isSuperAdmin(user) && !!user?.tenant_id,
  });

  // ── Regular user: show read-only tenant badge ──
  // Purely informational (not interactive) — hidden on phones where every
  // pixel of topbar width is needed for the view title and action icons;
  // visible from sm (tablet) up.
  if (!isSuperAdmin(user)) {
    const tt = myTenantQ.data;
    return (
      <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/50 border border-border/60">
        <Building2 className="size-3.5 text-muted-foreground shrink-0" />
        <span className="text-sm font-medium truncate max-w-[140px]">
          {tt?.name || t("pf-tenant")}
        </span>
        {tt?.plan && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 capitalize shrink-0">
            {tt.plan}
          </Badge>
        )}
      </div>
    );
  }

  // ── Super-admin: show tenant switcher ──
  const tenants = tenantsQ.data || [];
  const activeTenant = tenants.find((tt) => tt.id === activeTenantId);

  function handleSelect(tnt: Tenant) {
    setActiveTenant(tnt.id, tnt.name);
    setOpen(false);
    // Invalidate ALL queries so every view refetches with the new tenant context
    qc.clear();
    toast.success(t("misc-tenant-context-toast").replace("{name}", tnt.name), {
      description: t("misc-tenant-context-toast-desc"),
    });
  }

  function handleClear() {
    setActiveTenant(null, null);
    setOpen(false);
    qc.clear();
    toast.info(t("misc-tenant-showing-platform-wide"));
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-9 gap-0 sm:gap-2 px-2 sm:px-3 bg-card border-border/60 hover:bg-accent/50 max-w-[44px] sm:max-w-[260px]"
          title={activeTenant ? activeTenant.name : t("pf-all-tenants")}
        >
          <div className="flex items-center gap-2 min-w-0">
            {activeTenant ? (
              <>
                <div className="size-6 rounded-md bg-gradient-to-br from-primary/80 to-accent/80 flex items-center justify-center text-white shrink-0">
                  <Building2 className="size-3.5" />
                </div>
                {/* Two-line label — desktop/tablet only; mobile shows just the icon + chevron above */}
                <div className="hidden sm:block min-w-0 text-left">
                  <div className="text-xs text-muted-foreground leading-tight">{t("misc-tenant-context-label")}</div>
                  <div className="text-sm font-semibold truncate leading-tight">
                    {activeTenant.name}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="size-6 rounded-md bg-gradient-to-br from-[oklch(0.33_0.085_258)] to-[oklch(0.685_0.105_82)] flex items-center justify-center text-white shrink-0">
                  <Globe className="size-3.5" />
                </div>
                <div className="hidden sm:block min-w-0 text-left">
                  <div className="text-xs text-muted-foreground leading-tight">{t("misc-tenant-viewing-label")}</div>
                  <div className="text-sm font-semibold truncate leading-tight">{t("pf-all-tenants")}</div>
                </div>
              </>
            )}
            <ChevronsUpDown className="hidden sm:block size-3.5 text-muted-foreground shrink-0 ml-1" />
          </div>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[360px] p-0" align="start">
        <Command>
          <CommandInput placeholder={t("misc-tenant-search-placeholder")} />
          <CommandList>
            <CommandEmpty>{t("no_results")}</CommandEmpty>
            <CommandGroup heading={t("platform")}>
              <CommandItem
                onSelect={() => handleClear()}
                className="cursor-pointer"
              >
                <div className="flex items-center gap-2 w-full">
                  <div className="size-7 rounded-md bg-gradient-to-br from-[oklch(0.33_0.085_258)] to-[oklch(0.685_0.105_82)] flex items-center justify-center text-white shrink-0">
                    <Globe className="size-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{t("pf-all-tenants")}</div>
                    <div className="text-xs text-muted-foreground">{t("misc-tenant-platform-wide-desc")}</div>
                  </div>
                  {!activeTenantId && <Check className="size-4 text-primary" />}
                </div>
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading={t("tenants")}>
              {tenants.map((tnt) => (
                <CommandItem
                  key={tnt.id}
                  onSelect={() => handleSelect(tnt)}
                  className="cursor-pointer"
                >
                  <div className="flex items-center gap-2 w-full">
                    <div className="size-7 rounded-md bg-gradient-to-br from-primary/80 to-accent/80 flex items-center justify-center text-white shrink-0">
                      <Building2 className="size-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{tnt.name}</div>
                      <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                        {tnt.country && <span>{tnt.country}</span>}
                        {tnt.currency && <span>· {tnt.currency}</span>}
                        {tnt.plan && <span>· <span className="capitalize">{tnt.plan}</span></span>}
                      </div>
                    </div>
                    {activeTenantId === tnt.id && <Check className="size-4 text-primary shrink-0" />}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        <div className="border-t border-border/60 px-3 py-2 bg-muted/30">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5 text-primary" />
            <span>{t("misc-tenant-superadmin-mode")}</span>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
