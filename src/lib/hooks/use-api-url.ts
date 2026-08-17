"use client";

import React from "react";
import { useAppStore, isSuperAdmin } from "@/lib/store/app-store";

/**
 * Returns a function that builds API URLs with the active tenant context.
 *
 * Usage:
 *   const api = useApiUrl();
 *   const r = await fetch(api("/api/partners"));
 *   const r = await fetch(api("/api/partners", { limit: "200" }));
 *
 * For super-admins, this automatically appends ?tenant_id=xxx (or &tenant_id=xxx)
 * based on the selected tenant context. For regular users, no param is added
 * (the backend resolves tenant_id from their session).
 */
export function useApiUrl() {
  const activeTenantId = useAppStore((s) => s.activeTenantId);
  const user = useAppStore((s) => s.user);

  return React.useCallback(
    (path: string, params?: Record<string, string | number | boolean | undefined>) => {
      const url = new URL(path, typeof window !== "undefined" ? window.location.origin : "http://localhost");
      // Add caller params
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
        }
      }
      // Add tenant context for super-admins
      if (isSuperAdmin(user) && activeTenantId) {
        url.searchParams.set("tenant_id", activeTenantId);
      }
      // Return relative path + query string (for same-origin requests)
      return url.pathname + url.search;
    },
    [activeTenantId, user]
  );
}

/**
 * Returns the current active tenant ID for use in query keys.
 * Include this in TanStack Query keys so caches are isolated per tenant.
 */
export function useTenantKey(): string {
  const activeTenantId = useAppStore((s) => s.activeTenantId);
  const user = useAppStore((s) => s.user);
  if (isSuperAdmin(user)) return activeTenantId || "platform";
  return user?.tenant_id || "none";
}
