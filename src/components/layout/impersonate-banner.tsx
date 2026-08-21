"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, LogOut, Clock } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/store";

interface Impersonation {
  original_super_admin_id: string;
  original_username: string;
  target_user_id: string;
  target_tenant_id: string | null;
  expires_at: string;
}

interface MeResponse {
  user: { id: string; username: string; role: string; tenant_id: string | null } | null;
  impersonation?: Impersonation | null;
}

function useCountdown(expiresAtIso: string | null): string {
  const [now, setNow] = React.useState<number>(() => Date.now());
  React.useEffect(() => {
    if (!expiresAtIso) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [expiresAtIso]);
  if (!expiresAtIso) return "";
  const ms = Math.max(0, new Date(expiresAtIso).getTime() - now);
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}:${String(s).padStart(2, "0")}`;
}

export function ImpersonateBanner() {
  const qc = useQueryClient();
  const t = useT();
  const { data } = useQuery<MeResponse>({
    queryKey: ["me"],
    queryFn: async () => {
      const r = await fetch("/api/auth/me", { cache: "no-store" });
      return r.json();
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const imp = data?.impersonation || null;
  const target = data?.user || null;
  const remaining = useCountdown(imp?.expires_at || null);

  const endMut = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/super-admin/impersonate/end", { method: "POST" });
      if (!r.ok) throw new Error("Failed to end impersonation");
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("misc-impersonation-ended"));
      qc.invalidateQueries({ queryKey: ["me"] });
      // Full reload to clear tenant-scoped caches.
      setTimeout(() => window.location.reload(), 400);
    },
    onError: (e: Error) => toast.error(e.message || t("misc-impersonation-end-failed")),
  });

  if (!imp || !target) return null;

  return (
    <div
      className={cn(
        "sticky top-0 z-40 w-full",
        "bg-gradient-to-r from-red-600 via-orange-600 to-red-600",
        "text-white shadow-md",
      )}
      role="alert"
    >
      <div className="mx-auto max-w-[1600px] px-4 py-2 flex items-center gap-3 text-[13px] font-medium">
        <AlertTriangle className="size-4 shrink-0" />
        <span className="truncate">
          {t("misc-impersonating-as")} <span className="font-bold">{target.username}</span>
          {imp.target_tenant_id ? ` · ${t("pf-tenant")} ${imp.target_tenant_id.slice(0, 8)}…` : ""}
        </span>
        <span className="ml-auto flex items-center gap-1.5 opacity-90 tabular">
          <Clock className="size-3.5" />
          {remaining}
        </span>
        <button
          type="button"
          onClick={() => endMut.mutate()}
          disabled={endMut.isPending}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md",
            "bg-white/10 hover:bg-white/20 border border-white/25",
            "px-2.5 py-1 text-xs font-semibold smooth",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50",
            "disabled:opacity-50",
          )}
        >
          <LogOut className="size-3.5" />
          {t("misc-end-impersonation-btn")}
        </button>
      </div>
    </div>
  );
}
