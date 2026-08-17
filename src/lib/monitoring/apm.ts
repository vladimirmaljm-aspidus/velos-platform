/**
 * Application Performance Monitoring (APM)
 * ─────────────────────────────────────────────────────────────────────────────
 * Lightweight, in-process APM for the VELOS platform (task D-8).
 *
 * Captures three signals for every wrapped API handler:
 *   • response time   (ms, wall clock)
 *   • status code     (so we can derive error rate)
 *   • error message   (when the handler threw)
 *
 * Plus a "slow request" classification: any request that takes longer than
 * `SLOW_THRESHOLD_MS` is flagged and surfaced separately on the dashboard.
 *
 * Storage is an in-memory ring buffer (`metricsBuffer`) capped at
 * `MAX_BUFFER_SIZE` entries. The cap is a defense-in-depth against
 * unbounded memory growth if the dashboard hasn't been polled in a while
 * (the buffer shifts the oldest entry out once the cap is hit — FIFO).
 *
 * Per-instance scoping: the buffer lives in module scope, so on a
 * horizontally-scaled deployment (multiple Render replicas, serverless
 * functions) each replica sees only its own slice of traffic. The
 * dashboard's "total requests" therefore reflects the instance the
 * super-admin's request landed on, not the whole fleet. For a single-host
 * Render deployment (current production shape) this is accurate. For
 * multi-replica, a follow-up should flush this buffer to Postgres /
 * Prometheus / Grafana Cloud on an interval — see "Follow-ups" in the
 * worklog.
 *
 * No PII is captured: `route` is the URL path (with `?query` stripped),
 * `method` is the HTTP verb, `error` is the thrown Error's `message`
 * (sanitised by the route handlers before throwing — see `sanitizeError`
 * in `src/lib/api/helpers.ts`).
 */

export interface Metric {
  route: string;
  method: string;
  status: number;
  durationMs: number;
  timestamp: number;
  error?: string;
}

export interface RouteStats {
  count: number;
  avgMs: number;
  maxMs: number;
  errors: number;
  /** Sum of durations — kept so the dashboard can show p50/p95 without
   *  re-scanning the buffer; rounded when summarised. */
  totalMs: number;
  /** Slow requests (>2s) — surfaced as its own KPI on the dashboard. */
  slow: number;
}

export interface MetricsSummary {
  totalRequests: number;
  avgResponseTime: number;
  slowRequests: number;
  errorRate: number;
  byRoute: Record<string, RouteStats>;
}

/**
 * A request is considered "slow" if it takes longer than 2 seconds.
 * This matches the spec's threshold and is the cutoff the dashboard
 * uses for the "Slow Requests" KPI and the slow-route warning log line.
 */
export const SLOW_THRESHOLD_MS = 2000;

/**
 * Alert thresholds — surfaced by `checkAlerts()` and rendered as a banner
 * on the performance dashboard. Tuned conservatively: a 2s average means
 * the platform is genuinely struggling (most routes return in <200ms),
 * and 5% error rate is the SLO ceiling. Both are intentionally higher
 * than the per-request "slow" cutoff so transient spikes don't page.
 */
export const ALERT_THRESHOLDS = {
  avgResponseTimeMs: 2000,
  errorRate: 0.05,
  slowRequests: 10,
} as const;

// ── In-memory metrics buffer (ring buffer, FIFO eviction) ──────────────────
//
// The buffer is intentionally NOT exported — the only sanctioned access
// patterns are `recordMetric`, `getMetrics`, `getMetricsSummary`, and
// `clearMetrics`. External mutation would risk double-counting or
// dropping entries mid-summary.
const metricsBuffer: Metric[] = [];
const MAX_BUFFER_SIZE = 1000;

/**
 * Append a metric to the buffer. If the buffer is full, the oldest entry
 * is dropped (FIFO). This is O(1) for `push` + `shift` on a JS array of
 * 1000 entries — `shift` is technically O(n) but n=1000 so the constant
 * is negligible (~microseconds). If we ever raise the cap to 10k+,
 * switch to a proper circular buffer.
 */
export function recordMetric(metric: Metric): void {
  metricsBuffer.push(metric);
  if (metricsBuffer.length > MAX_BUFFER_SIZE) {
    metricsBuffer.shift();
  }
}

/**
 * Return a shallow copy of the current buffer. Callers must NOT mutate
 * the returned array — it's a snapshot for read-only rendering.
 */
export function getMetrics(): Metric[] {
  return [...metricsBuffer];
}

/**
 * Reset the buffer. Used by tests and by the super-admin "Clear metrics"
 * action on the dashboard (when added). Production traffic will not
 * normally call this.
 */
export function clearMetrics(): void {
  metricsBuffer.length = 0;
}

/**
 * Aggregate the buffer into the shape the performance dashboard expects.
 *
 * Returns a zeroed summary if the buffer is empty so the UI can render
 * its empty-state without null-checking every field.
 *
 * `byRoute` is keyed by `"METHOD /path"` — the same key format used by
 * the slow-request warning log line, so a super-admin can correlate a
 * dashboard alert with a `[APM] Slow request` log entry.
 *
 * `avgMs` per route is rounded to the nearest millisecond (sub-ms
 * precision is noise on a 1000-sample window). `maxMs` is the worst
 * observed latency for that route in the current buffer.
 */
export function getMetricsSummary(): MetricsSummary {
  const metrics = getMetrics();
  if (metrics.length === 0) {
    return {
      totalRequests: 0,
      avgResponseTime: 0,
      slowRequests: 0,
      errorRate: 0,
      byRoute: {},
    };
  }

  const totalTime = metrics.reduce((sum, m) => sum + m.durationMs, 0);
  const slowRequests = metrics.filter((m) => m.durationMs > SLOW_THRESHOLD_MS).length;
  const errors = metrics.filter((m) => m.status >= 500).length;

  const byRoute: Record<string, RouteStats> = {};
  for (const m of metrics) {
    const key = `${m.method} ${m.route}`;
    if (!byRoute[key]) {
      byRoute[key] = { count: 0, avgMs: 0, maxMs: 0, errors: 0, totalMs: 0, slow: 0 };
    }
    const r = byRoute[key];
    r.count++;
    r.totalMs += m.durationMs;
    r.maxMs = Math.max(r.maxMs, m.durationMs);
    if (m.status >= 500) r.errors++;
    if (m.durationMs > SLOW_THRESHOLD_MS) r.slow++;
  }

  for (const key of Object.keys(byRoute)) {
    const r = byRoute[key];
    r.avgMs = Math.round(r.totalMs / r.count);
  }

  return {
    totalRequests: metrics.length,
    avgResponseTime: Math.round(totalTime / metrics.length),
    slowRequests,
    errorRate: errors / metrics.length,
    byRoute,
  };
}

/**
 * Inspect the buffer for concerning patterns and return human-readable
 * alert strings. Empty array = no alerts. Used by the performance
 * dashboard to render an alert banner, and could be polled by an
 * external notifier (Slack / email) in a follow-up.
 *
 * Thresholds (configurable via `ALERT_THRESHOLDS` above):
 *   • average response time > 2s        → "High average response time"
 *   • error rate > 5%                   → "High error rate"
 *   • more than 10 slow requests (>2s)  → "N slow requests in the last window"
 *
 * The thresholds are deliberately higher than the per-request "slow"
 * cutoff — a single slow request is fine (e.g. a heavy export), but a
 * sustained pattern across the buffer is a real degradation signal.
 */
export function checkAlerts(): string[] {
  const summary = getMetricsSummary();
  const alerts: string[] = [];

  if (summary.totalRequests === 0) return alerts;

  if (summary.avgResponseTime > ALERT_THRESHOLDS.avgResponseTimeMs) {
    alerts.push(`High average response time: ${summary.avgResponseTime}ms`);
  }
  if (summary.errorRate > ALERT_THRESHOLDS.errorRate) {
    alerts.push(`High error rate: ${(summary.errorRate * 100).toFixed(1)}%`);
  }
  if (summary.slowRequests > ALERT_THRESHOLDS.slowRequests) {
    alerts.push(
      `${summary.slowRequests} slow requests (>2s) in the last window`,
    );
  }

  return alerts;
}

/**
 * Type of the API handler we wrap. We intentionally stay loose (`any[]`
 * args, `any` return) because Next.js route handlers have heterogeneous
 * signatures (some take `{ params }`, some don't) and return
 * `NextResponse | Promise<NextResponse>`. The generic `T` preserves the
 * wrapped function's type at the call site so `export const GET = withApm(...)`
 * still type-checks against Next's expected `RouteHandler` shape.
 */
type AnyHandler = (...args: any[]) => any;

/**
 * Wrap an API handler with APM tracking.
 *
 * Records:
 *   • the wall-clock duration from invocation to resolution
 *   • the resulting HTTP status (read from the returned NextResponse's
 *     `.status` — every wrapped handler in this codebase returns a
 *     `NextResponse`, so this is reliable)
 *   • the error message if the handler threw (sanitised upstream by
 *     `sanitizeError` before being rethrown — the APM layer just records
 *     what it sees)
 *
 * Slow-request warning: if the duration exceeds `SLOW_THRESHOLD_MS`, a
 * `[APM] Slow request: METHOD /route took Nms` line is written to
 * `console.warn`. This is the primary operational signal — it shows up
 * in the Render logs immediately, without waiting for a dashboard poll.
 *
 * The wrapper preserves the wrapped handler's arity and return type via
 * the generic `T`, so callers can use it as a transparent decorator:
 *
 *   export const GET = withApm(originalGet, "GET /api/products");
 *
 * `routeName` is optional — if omitted, the wrapper falls back to
 * `req.url` (with `?query` stripped). Passing an explicit `routeName`
 * is preferred because `req.url` includes the dynamic path segment
 * (e.g. `/api/products/abc-123`) which would create a distinct
 * `byRoute` key for every resource ID — destroying the aggregation.
 * For dynamic routes (`/api/products/[id]`), always pass the static
 * route name.
 */
export function withApm<T extends AnyHandler>(
  handler: T,
  routeName?: string,
): T {
  return (async (req: any, ...args: any[]) => {
    const start = Date.now();
    const method = req?.method || "GET";
    const route =
      routeName ||
      (req?.url ? String(req.url).split("?")[0] : "unknown");

    try {
      const result = await handler(req, ...args);
      const durationMs = Date.now() - start;
      // NextResponse extends Response, so `.status` is always present.
      // Default to 200 if the handler returned something weird
      // (e.g. a raw object — shouldn't happen in this codebase, but
      // defends against future drift).
      const status = result?.status || 200;

      recordMetric({ route, method, status, durationMs, timestamp: Date.now() });

      if (durationMs > SLOW_THRESHOLD_MS) {
        console.warn(
          `[APM] Slow request: ${method} ${route} took ${durationMs}ms`,
        );
      }

      return result;
    } catch (error) {
      const durationMs = Date.now() - start;
      recordMetric({
        route,
        method,
        status: 500,
        durationMs,
        timestamp: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }) as T;
}
