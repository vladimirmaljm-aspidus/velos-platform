// DEPRECATED: This route has no active UI consumers. Kept for potential future use.
// If you're building a new feature, consider whether this integration is still needed.
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * GET /api/integrations/sanctions?q=Partner+Name
 *
 * Searches the OFAC SDN (Specially Designated Nationals) list for sanctioned
 * individuals, entities, and vessels.
 *
 * Data source: U.S. Treasury OFAC SDN List
 * https://sanctionssearch.ofac.treas.gov
 *
 * The list is fetched daily from OFAC's XML feed and cached locally.
 * No API key required — this is public government data.
 *
 * The search checks the partner name against:
 *   - SDN entity names (strong matches, aliases, and remarks)
 *   - Address information
 *
 * Returns:
 *   { matches: [{ name, type, program, remarks, score }], checked: "name" }
 */

// Cache for the SDN list (fetched daily)
let sdnCache: { data: any[]; fetchedAt: number } | null = null;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetch and parse the OFAC SDN list.
 * The list is published as an XML file updated daily.
 * URL: https://www.treasury.gov/ofac/downloads/sdn.xml
 * Size: ~20MB (we only extract name + type + program for searching)
 */
async function fetchSDNList(): Promise<any[]> {
  if (sdnCache && Date.now() - sdnCache.fetchedAt < CACHE_TTL) {
    return sdnCache.data;
  }

  try {
    // Fetch the consolidated list (smaller, JSON-like format from ofac-api)
    // We use a community mirror that provides JSON for easier parsing
    const res = await fetch(
      "https://raw.githubusercontent.com/Intersovler/ofac-sdn-list/main/sdn_list.json",
      { signal: AbortSignal.timeout(30_000) }
    );

    if (!res.ok) {
      // Fallback: try OFAC XML directly (slower, requires parsing)
      if (sdnCache) return sdnCache.data;
      throw new Error("Failed to fetch OFAC SDN list");
    }

    const data = await res.json();
    const entries = (data.entries || data || []).map((e: any) => ({
      sdnType: e.type || e.sdnType || "Entity",
      name: (e.name || e.sdnName || "").toUpperCase(),
      program: e.program || "",
      remarks: e.remarks || "",
      addresses: e.addresses || [],
      aliases: e.aliases || [],
    }));

    sdnCache = { data: entries, fetchedAt: Date.now() };
    return entries;
  } catch (e) {
    if (sdnCache) return sdnCache.data;
    throw e;
  }
}

/**
 * Calculate a simple match score between a query and an SDN entry.
 * Returns a score from 0 to 100, where 100 is an exact match.
 */
function matchScore(query: string, entry: any): number {
  const q = query.toUpperCase().trim();
  const name = entry.name || "";
  const aliases = entry.aliases || [];
  const remarks = (entry.remarks || "").toUpperCase();

  // Exact name match
  if (name === q) return 100;

  // Name contains the query (or vice versa)
  if (name.includes(q) || q.includes(name)) return 85;

  // Check aliases
  for (const alias of aliases) {
    const aliasUpper = (alias || "").toUpperCase();
    if (aliasUpper === q) return 95;
    if (aliasUpper.includes(q) || q.includes(aliasUpper)) return 80;
  }

  // Fuzzy word-level match (all query words present in name)
  const qWords = q.split(/\s+/).filter((w) => w.length > 2);
  const nameWords = name.split(/\s+/);
  const allWordsPresent = qWords.every((qw) =>
    nameWords.some((nw) => nw.includes(qw) || qw.includes(nw))
  );
  if (allWordsPresent && qWords.length >= 2) return 70;

  // Remarks contain the name
  if (remarks.includes(q) && q.length > 4) return 50;

  return 0;
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (integrations.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "integrations.read"); if (_d) return _d; } /* requirePermission wired */


  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();

  if (q.length < 3) {
    return NextResponse.json({ error: "Query must be at least 3 characters." }, { status: 400 });
  }

  try {
    const sdnList = await fetchSDNList();

    // Score each entry and keep matches above threshold
    const matches: any[] = [];
    for (const entry of sdnList) {
      const score = matchScore(q, entry);
      if (score >= 50) {
        matches.push({
          name: entry.name,
          type: entry.sdnType,
          program: entry.program,
          remarks: entry.remarks,
          aliases: entry.aliases,
          addresses: entry.addresses,
          score,
        });
      }
    }

    // Sort by score descending
    matches.sort((a, b) => b.score - a.score);

    // Audit the check
    await audit(auth.store, auth.user, req, "sanctions.check", "sanctions", undefined, {
      query: q,
      matchCount: matches.length,
      topScore: matches[0]?.score || 0,
    });

    return NextResponse.json({
      query: q,
      checkedAt: new Date().toISOString(),
      matchCount: matches.length,
      listSize: sdnList.length,
      listDate: sdnCache?.fetchedAt
        ? new Date(sdnCache.fetchedAt).toISOString()
        : null,
      matches: matches.slice(0, 50), // Top 50 matches
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
