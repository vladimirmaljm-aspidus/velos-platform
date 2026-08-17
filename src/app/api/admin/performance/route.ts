import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/api/helpers";
import {
  getMetrics,
  getMetricsSummary,
  checkAlerts,
  clearMetrics,
  SLOW_THRESHOLD_MS,
} from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/performance
//
// Returns the live APM snapshot for the super-admin performance dashboard
// (task D-8). The payload combines:
//
//   • summary   — aggregate KPIs (total reqs, avg response time, slow reqs,
//                 error rate, per-route stats)
//   • alerts    — list of human-readable alert strings (empty when healthy)
//   • metrics   — the raw metric buffer (capped at 1000 entries, FIFO)
//                 used by the dashboard's "Response time over time" line
//                 chart and the per-route tables
//   • process   — uptime + memoryUsage so the dashboard can show a
//                 "Memory" tile without a separate /api/health call
//
// Auth: super_admin only. This is platform-level telemetry — exposing it
// to tenant admins would leak cross-tenant traffic patterns (which routes
// exist, how busy the platform is). `requireSuperAdmin` enforces this.
//
// The buffer is in-memory and per-instance — see apm.ts header comment
// for the multi-replica caveat.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const summary = getMetricsSummary();
  const alerts = checkAlerts();
  const metrics = getMetrics();

  // Memory snapshot — `process.memoryUsage()` returns bytes. We convert
  // the four most useful fields to MB (rounded) so the dashboard can
  // render them without a unit-conversion helper. `rss` is the total
  // resident set size (what the OS sees); `heapUsed` is the V8 JS heap;
  // `heapTotal` is the allocated heap (includes free slots); `external`
  // is C++ objects bound to JS (Buffer, MapLibre tiles, etc.).
  const mem = process.memoryUsage();
  const memory = {
    rssMb: Math.round(mem.rss / 1024 / 1024),
    heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
    externalMb: Math.round(mem.external / 1024 / 1024),
  };

  return NextResponse.json({
    summary,
    alerts,
    metrics,
    memory,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    slowThresholdMs: SLOW_THRESHOLD_MS,
    // Buffer capacity — surfaced so the dashboard can show "showing N of
    // MAX_BUFFER_SIZE" when the buffer is full (indicating the dashboard
    // hasn't been polled in a while and older entries are being dropped).
    bufferCapacity: 1000,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/admin/performance
//
// Clears the in-memory metrics buffer. Used by the dashboard's "Reset"
// button so a super-admin can start a fresh measurement window after a
// deploy / restart / config change. Returns the (now empty) summary so
// the client can update without an extra GET round-trip.
// ─────────────────────────────────────────────────────────────────────────────

export async function DELETE(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  clearMetrics();
  return NextResponse.json({
    summary: getMetricsSummary(),
    alerts: checkAlerts(),
    metrics: [],
    timestamp: new Date().toISOString(),
    cleared: true,
  });
}
