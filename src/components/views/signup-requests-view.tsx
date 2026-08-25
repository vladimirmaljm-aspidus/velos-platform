"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, UserPlus, Check, X, ShieldAlert, Building2 } from "lucide-react";
import { toast } from "sonner";
import { useAppStore, isSuperAdmin } from "@/lib/store/app-store";
import { PageHeader } from "@/components/common/page-header";

/* ═══════════════════════════════════════════════════════════════════════════
   FEAT-1 (Trial approval system) — super-admin queue view.
   ═══════════════════════════════════════════════════════════════════════════ */
/**
 * `SignupRequestsView` — super-admin-only surface that lists every
 * tenant in `pending_approval` status, with the requesting admin's
 * contact info (company, contact name, email, phone, country, request
 * date). Two actions per row:
 *
 *   • Approve  → POST /api/super-admin/signup-requests/[id]/approve
 *     Flips the tenant to `trial`, sets trial_ends_at = now + 14d,
 *     sends the welcome email, posts an in-app notification. The user
 *     can then log in via /api/auth/login.
 *
 *   • Reject   → POST /api/super-admin/signup-requests/[id]/reject
 *     Sends a rejection email to the requesting user, then cascade-
 *     deletes the tenant + its admin user + every dependent row.
 *
 * Auto-refresh: invalidate the list query on either mutation success
 * (the row leaves the list immediately). Empty state surfaces a clean
 * "No pending signup requests" card.
 *
 * Defense-in-depth: the view re-checks isSuperAdmin before rendering
 * the table; if a non-super-admin reaches this state via state
 * manipulation, they see a denial card instead of firing 403 fetches
 * (the queries' `enabled: isSuper` flag short-circuits them too).
 */

interface SignupRequest {
  id: string;
  company_name: string;
  contact_name: string;
  email: string;
  phone: string | null;
  country: string | null;
  plan: string;
  requested_at: string;
  currency: string | null;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function SignupRequestsView() {
  const qc = useQueryClient();
  const userObj = useAppStore((s) => s.user);
  const isSuper = isSuperAdmin(userObj);

  // Hooks must run unconditionally to comply with
  // react-hooks/rules-of-hooks. The access-denied early return is
  // placed AFTER all hook calls below.
  const reqsQ = useQuery({
    queryKey: ["signup-requests"],
    queryFn: async () => {
      const r = await fetch("/api/super-admin/signup-requests");
      if (!r.ok) {
        throw new Error(`Failed to load signup requests (${r.status})`);
      }
      return r.json() as Promise<{ items: SignupRequest[] }>;
    },
    // `enabled` short-circuits the fetch for non-super-admins who
    // reach this view via state manipulation (the sidebar hides the
    // nav item, but defense-in-depth).
    enabled: isSuper,
    // Auto-refresh every 60s so a super_admin who leaves the tab open
    // sees new pending requests without manual refresh.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const approveMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(
        `/api/super-admin/signup-requests/${encodeURIComponent(id)}/approve`,
        { method: "POST" },
      );
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(data?.error || `Approval failed (${r.status})`);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("Signup request approved — welcome email sent.");
      // Invalidate the list so the approved row disappears.
      void qc.invalidateQueries({ queryKey: ["signup-requests"] });
    },
    onError: (e: Error) => {
      toast.error(e.message || "Failed to approve signup request.");
    },
  });

  const rejectMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(
        `/api/super-admin/signup-requests/${encodeURIComponent(id)}/reject`,
        { method: "POST" },
      );
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(data?.error || `Rejection failed (${r.status})`);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("Signup request rejected. Tenant + user deleted.");
      void qc.invalidateQueries({ queryKey: ["signup-requests"] });
    },
    onError: (e: Error) => {
      toast.error(e.message || "Failed to reject signup request.");
    },
  });

  // ── Access-denied early return (placed after all hook calls so
  // rules-of-hooks is preserved). Mirrors platform-users-view.
  if (!isSuper) {
    return (
      <div>
        <PageHeader title="Signup Requests" />
        <Card className="border-amber-500/40 bg-amber-50/50 dark:bg-amber-950/20 rounded-xl">
          <CardContent className="p-6 flex items-center gap-3">
            <ShieldAlert className="size-5 text-amber-600 shrink-0" />
            <p className="text-sm text-amber-800 dark:text-amber-300">
              Super-admin access required to review signup requests.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const items = reqsQ.data?.items || [];
  const isLoading = reqsQ.isLoading;
  const isFetching = reqsQ.isFetching && !isLoading;

  return (
    <div>
      <PageHeader
        title="Signup Requests"
        description="Self-registered trial signups waiting for approval. Approving activates the 14-day trial; rejecting cascade-deletes the tenant + user."
      />

      {isLoading ? (
        <Card className="rounded-xl">
          <CardContent className="p-6 flex items-center justify-center gap-3 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
            <span className="text-sm">Loading pending signup requests…</span>
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card className="rounded-xl border-dashed">
          <CardContent className="p-10 flex flex-col items-center justify-center gap-3 text-center">
            <div className="size-12 rounded-full bg-muted flex items-center justify-center">
              <UserPlus className="size-6 text-muted-foreground" />
            </div>
            <div>
              <p className="text-base font-medium">No pending signup requests</p>
              <p className="text-sm text-muted-foreground mt-1">
                New self-registered signups will appear here for review.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="rounded-xl">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <UserPlus className="size-5" />
              Pending approval
              {isFetching && (
                <Loader2 className="size-3.5 animate-spin text-muted-foreground ml-2" />
              )}
            </CardTitle>
            <CardDescription>
              {items.length} request{items.length === 1 ? "" : "s"} awaiting review.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[180px]">Company</TableHead>
                  <TableHead className="min-w-[140px]">Contact</TableHead>
                  <TableHead className="min-w-[200px]">Email</TableHead>
                  <TableHead className="min-w-[120px]">Phone</TableHead>
                  <TableHead className="min-w-[80px]">Country</TableHead>
                  <TableHead className="min-w-[140px]">Requested</TableHead>
                  <TableHead className="min-w-[80px]">Plan</TableHead>
                  <TableHead className="text-right min-w-[180px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((req) => {
                  const approving = approveMut.isPending && approveMut.variables === req.id;
                  const rejecting = rejectMut.isPending && rejectMut.variables === req.id;
                  const busy = approving || rejecting;
                  return (
                    <TableRow key={req.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Building2 className="size-4 text-muted-foreground shrink-0" />
                          <span className="font-medium">{req.company_name}</span>
                        </div>
                      </TableCell>
                      <TableCell>{req.contact_name}</TableCell>
                      <TableCell>
                        <a
                          href={`mailto:${req.email}`}
                          className="text-blue-600 hover:underline dark:text-blue-400"
                        >
                          {req.email}
                        </a>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {req.phone || "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{req.country || "—"}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {formatDate(req.requested_at)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{req.plan}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="default"
                            disabled={busy}
                            onClick={() => approveMut.mutate(req.id)}
                          >
                            {approving ? (
                              <>
                                <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                                Approving…
                              </>
                            ) : (
                              <>
                                <Check className="size-3.5 mr-1.5" />
                                Approve
                              </>
                            )}
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={busy}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Reject ${req.company_name}? This will delete the tenant and user. They will receive a rejection email.`,
                                )
                              ) {
                                rejectMut.mutate(req.id);
                              }
                            }}
                          >
                            {rejecting ? (
                              <>
                                <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                                Rejecting…
                              </>
                            ) : (
                              <>
                                <X className="size-3.5 mr-1.5" />
                                Reject
                              </>
                            )}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
