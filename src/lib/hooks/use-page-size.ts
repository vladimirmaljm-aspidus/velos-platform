"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

/**
 * Per-user, per-module page-size preference.
 *
 * Persistence:
 *   - Server: /api/user-preferences (key = `pagesize.${module}`)
 *   - Client cache: React Query
 *   - Fallback while loading / unauthenticated: localStorage
 *
 * Usage:
 *   const { pageSize, setPageSize, options } = usePageSize("offers", 20);
 *
 * The default (2nd arg) is used until the server preference loads.
 */

const OPTIONS = [10, 20, 50, 100, 200, 500] as const;
export type PageSizeOption = (typeof OPTIONS)[number];

const LS_PREFIX = "velos_pagesize_";

type PrefsMap = Record<string, unknown>;

function readLocal(module: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(LS_PREFIX + module);
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

function writeLocal(module: string, value: number) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(LS_PREFIX + module, String(value));
  } catch {
    /* quota / private mode */
  }
}

export function usePageSize(module: string, fallback = 20) {
  const qc = useQueryClient();
  const key = `pagesize.${module}`;

  const { data } = useQuery({
    queryKey: ["user-preferences"],
    queryFn: async () => {
      const r = await fetch("/api/user-preferences", { credentials: "include" });
      if (!r.ok) return { map: {} as PrefsMap };
      return r.json() as Promise<{ map: PrefsMap }>;
    },
    staleTime: 60_000,
    retry: false,
  });

  const [local, setLocal] = React.useState<number>(() => readLocal(module, fallback));

  React.useEffect(() => {
    const server = data?.map?.[key];
    if (typeof server === "number" && server > 0) {
      setLocal(server);
      writeLocal(module, server);
    }
  }, [data, key, module]);

  const mut = useMutation({
    mutationFn: async (value: number) => {
      const r = await fetch("/api/user-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ key, value }),
      });
      if (!r.ok) throw new Error("Failed to save preference");
      return r.json();
    },
    onSuccess: (_, value) => {
      writeLocal(module, value);
      qc.setQueryData<{ map: PrefsMap }>(["user-preferences"], (prev) => ({
        map: { ...(prev?.map || {}), [key]: value },
      }));
    },
  });

  const setPageSize = React.useCallback(
    (value: number) => {
      setLocal(value);
      writeLocal(module, value);
      mut.mutate(value);
    },
    [module, mut],
  );

  return {
    pageSize: local,
    setPageSize,
    options: OPTIONS as unknown as number[],
  };
}
