"use client";

import { useQuery } from "@tanstack/react-query";

export interface BadgeCounts {
  kyc_review: number;
  portal_rfqs: number;
  logistics_requests: number;
  notifications: number;
  tasks: number;
  portal_messages: number;
}

const EMPTY: BadgeCounts = {
  kyc_review: 0,
  portal_rfqs: 0,
  logistics_requests: 0,
  notifications: 0,
  tasks: 0,
  portal_messages: 0,
};

/**
 * Polls /api/badge-counts every 30s to drive small numeric badges on
 * sidebar module names (e.g. "KYC Review 3"). Disabled entirely for portal
 * mode / unauthenticated sessions via the `enabled` flag.
 */
export function useBadgeCounts(enabled: boolean) {
  const { data } = useQuery({
    queryKey: ["badge-counts"],
    queryFn: async () => {
      const r = await fetch("/api/badge-counts", { credentials: "include" });
      if (!r.ok) return EMPTY;
      return r.json() as Promise<BadgeCounts>;
    },
    enabled,
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: false,
  });

  return data || EMPTY;
}
