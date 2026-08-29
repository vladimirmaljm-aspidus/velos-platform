// src/lib/webhooks/url-validation.ts
// ----------------------------------------------------------------------------
// FIX-AUDIT4-SEC / Fix 10 — SSRF validation for outbound webhook URLs.
//
// Background
// ----------
// The webhook POST route (src/app/api/webhooks/route.ts) accepts a `url`
// field from the tenant admin and stores it verbatim in the `webhooks`
// table. The webhook delivery worker (src/lib/webhooks/deliver.ts) later
// POSTs to that URL with the tenant's event payload. Without validation,
// a `webhooks:create` caller can register a webhook pointing at:
//
//   • http://169.254.169.254/latest/meta-data/ — the GCP / AWS / Azure
//     instance-metadata endpoint. A successful delivery leaks the
//     instance's service-account token (GCP) / IAM credentials (AWS).
//   • http://10.0.0.5:9090/ — any RFC-1918 internal address (Redis,
//     Postgres, internal admin consoles, the platform's own /api/*).
//   • http://127.0.0.1:3000/admin/... — the platform's own admin surface
//     via loopback (bypasses the auth gate because the request comes
//     from localhost, which some middleware whitelists).
//   • http://[::1]:6379/... — Redis on the IPv6 loopback.
//
// This module exposes a single function, `assertSafeWebhookUrl(url)`,
// which the POST route calls BEFORE persisting the webhook. It:
//   1. Parses the URL (rejects non-URL strings).
//   2. Rejects non-http(s) schemes (file://, gopher://, …).
//   3. Resolves the hostname via `dns.lookup` (so DNS rebinding where
//      the first lookup returns a public IP and the second returns a
//      private IP is partially mitigated — we resolve once and check
//      the resolved address, and the delivery worker should re-resolve
//      at delivery time to close the gap fully).
//   4. Rejects the resolved address if it falls in any of the
//      non-routable / loopback / link-local / metadata ranges:
//        IPv4: 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16
//        IPv6: ::1, fc00::/7 (unique-local), fe80::/10 (link-local)
//   5. Rejects the hostname `metadata.google.internal` (the GCP
//      metadata endpoint — its IP is dynamically assigned inside
//      169.254.0.0/16, but a misconfigured /etc/hosts entry could
//      resolve it to a non-link-local address; belt-and-braces).
//
// Returns `{ ok: true }` on success or `{ ok: false, error: string }`
// on failure. The POST route converts the latter into a 400 response.
// ----------------------------------------------------------------------------
import { lookup, LookupAddress } from "dns";
import { isIP } from "net";

export type WebhookUrlValidationResult =
  | { ok: true; resolvedHost: string }
  | { ok: false; error: string };

/**
 * The set of hostnames that are ALWAYS rejected, regardless of how
 * they resolve. `metadata.google.internal` is the GCP metadata
 * endpoint — even if the resolver somehow returns a public IP, we
 * still reject the hostname (belt-and-braces against /etc/hosts
 * tampering or a custom DNS server).
 */
const BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata",
  "metadata.aws.internal",
]);

/**
 * Returns true if the given IPv4 address falls in any of the
 * non-routable / loopback / link-local / RFC-1918 ranges.
 *
 *   10.0.0.0/8       — RFC 1918 private (10/8)
 *   172.16.0.0/12    — RFC 1918 private (172.16/12)
 *   192.168.0.0/16   — RFC 1918 private (192.168/16)
 *   127.0.0.0/8      — loopback (127/8)
 *   169.254.0.0/16   — link-local + cloud metadata endpoints
 *                      (AWS / GCP / Azure all use 169.254.169.254)
 *   0.0.0.0/8        — "this host" / unspecified
 *   100.64.0.0/10    — CGNAT (RFC 6598) — usually not reachable from
 *                      a typical cloud VPC, but reject anyway.
 *   192.0.2.0/24     — TEST-NET-1 (documentation)
 *   198.51.100.0/24 — TEST-NET-2
 *   203.0.113.0/24  — TEST-NET-3
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true; // malformed — treat as unsafe
  }
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && parts[2] === 2) return true;
  if (a === 198 && b === 51 && parts[2] === 100) return true;
  if (a === 203 && b === 0 && parts[2] === 113) return true;
  return false;
}

/**
 * Returns true if the given IPv6 address falls in any non-routable range.
 *
 *   ::1            — loopback
 *   ::             — unspecified
 *   fc00::/7       — unique-local (fc00::/7 covers fc00:: through fdff::)
 *   fe80::/10      — link-local
 *   ff00::/8       — multicast (not strictly private but a webhook
 *                    target should never be a multicast address)
 */
function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  if (lower === "::") return true;
  // Strip the IPv4-mapped prefix ::ffff: and re-check the embedded v4.
  // e.g. ::ffff:169.254.169.254 → check the v4 part.
  const v4Mapped = lower.match(/^::ffff:([0-9.]+)$/i);
  if (v4Mapped) {
    return isPrivateIPv4(v4Mapped[1]);
  }
  // Unique-local fc00::/7 — first hex byte 0xfc or 0xfd.
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // Link-local fe80::/10 — first hex byte 0xfe, second nibble 8-b.
  if (lower.startsWith("fe8") || lower.startsWith("fe9") ||
      lower.startsWith("fea") || lower.startsWith("feb")) return true;
  // Multicast ff00::/8
  if (lower.startsWith("ff")) return true;
  return false;
}

function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  // Unknown family — treat as unsafe.
  return true;
}

/**
 * Validate a webhook target URL for SSRF safety. Returns a discriminated
 * union — the POST route converts `{ ok: false }` into a 400 response.
 *
 * The function is async because it resolves the hostname via `dns.lookup`
 * to inspect the resolved IP(s). `dns.lookup` (not `dns.resolve`) is used
 * because it mirrors the OS resolver that the outbound `fetch()` in the
 * delivery worker will use — the validation sees the same address the
 * delivery will hit, modulo DNS rebinding between validation and
 * delivery (the delivery worker should re-resolve at delivery time;
 * this validation is the create-time gate, not the delivery-time one).
 */
export async function assertSafeWebhookUrl(
  rawUrl: string,
): Promise<WebhookUrlValidationResult> {
  if (!rawUrl || typeof rawUrl !== "string") {
    return { ok: false, error: "Webhook URL is required." };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: "Invalid URL." };
  }

  // ── Scheme allowlist — only http / https. ─────────────────────────────
  // gopher://, file://, dict://, ftp://, etc. all have known SSRF /
  // RCE surface against the cloud-metadata path or against internal
  // services speaking those protocols.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `Webhook URL scheme "${parsed.protocol.replace(":", "")}" is not allowed. Use http or https.` };
  }

  // ── No credentials in the URL — they'd be silently logged. ────────────
  if (parsed.username || parsed.password) {
    return { ok: false, error: "Webhook URL must not contain credentials." };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    return { ok: false, error: "Webhook URL is missing a hostname." };
  }

  // ── Hard-blocked hostnames — GCP / AWS metadata endpoints. ────────────
  // These resolve to 169.254.x.x (link-local) which the IP check below
  // would also catch, but blocking the hostname explicitly is belt-and-
  // braces against /etc/hosts tampering or a custom DNS resolver that
  // returns a public IP for the metadata hostname.
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { ok: false, error: `Hostname "${hostname}" is blocked (cloud metadata endpoint).` };
  }

  // ── Resolve the hostname via dns.lookup (uses the OS resolver). ──────
  // dns.lookup returns the same address that `fetch()` will hit (modulo
  // DNS rebinding between this call and the delivery worker's call —
  // the delivery worker should re-resolve and re-check at delivery time;
  // this is the create-time gate).
  let resolved: LookupAddress[];
  try {
    resolved = await new Promise<LookupAddress[]>((resolveP, rejectP) => {
      lookup(hostname, { all: true, family: 0 }, (err, addresses) => {
        if (err) return rejectP(err);
        resolveP(addresses);
      });
    });
  } catch (e) {
    return {
      ok: false,
      error: `Could not resolve hostname "${hostname}": ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (resolved.length === 0) {
    return { ok: false, error: `Hostname "${hostname}" did not resolve to any address.` };
  }

  // ── Reject if ANY resolved address is private / loopback / link-local. ─
  // We check ALL addresses (not just the first) because the resolver may
  // return a mix of public and private addresses — if any one is private,
  // the hostname is unsafe (the delivery worker may pick the private one
  // at delivery time).
  for (const addr of resolved) {
    if (isPrivateAddress(addr.address)) {
      return {
        ok: false,
        error: `Webhook URL resolves to a non-routable address (${addr.address}). Private, loopback, link-local, and cloud-metadata IP ranges are not allowed.`,
      };
    }
  }

  // ── Reject ports that point at well-known internal services. ─────────
  // This is defense-in-depth — the IP-range check above already blocks
  // the private addresses where these services typically live, but a
  // misconfigured DNS record could point a public hostname at a public
  // IP that NATs to an internal service on one of these ports. The
  // allowlist below covers the most-abused internal-service ports.
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  const BLOCKED_PORTS = new Set([
    22,    // SSH
    23,    // Telnet
    25,    // SMTP
    53,    // DNS
    110,   // POP3
    143,   // IMAP
    161,   // SNMP
    389,   // LDAP
    445,   // SMB
    465,   // SMTPS
    587,   // SMTP submission
    636,   // LDAPS
    993,   // IMAPS
    995,   // POP3S
    1433,  // MSSQL
    1521,  // Oracle
    3306,  // MySQL
    3389,  // RDP
    5432,  // Postgres
    6379,  // Redis
    9200,  // Elasticsearch
    11211, // Memcached
    27017, // MongoDB
  ]);
  if (BLOCKED_PORTS.has(port)) {
    return {
      ok: false,
      error: `Webhook URL targets port ${port}, which is reserved for an internal service. Use a standard HTTP(S) port.`,
    };
  }

  return { ok: true, resolvedHost: hostname };
}
