/**
 * Template publish/restore helpers (audit35 Document Studio).
 *
 * A "publish" snapshots the whole template (every whitelisted column) into
 * template_versions — append-only, max(version)+1. A restore writes a
 * snapshot back and auto-snapshots the CURRENT state first, so history is
 * never lost and any issued document can always be re-rendered exactly as
 * it looked ("reproducibility").
 */

import type { Store } from "@/lib/data/store";
import type { DocumentTemplate } from "@/lib/supabase/types";
import { TEMPLATE_COLUMNS } from "@/lib/api/template-payload";

/** Columns captured in a version snapshot (exactly the sanitizer whitelist). */
export function snapshotTemplateColumns(t: DocumentTemplate | Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of TEMPLATE_COLUMNS) {
    if (col === "content_json") {
      // Blocks can be ~96KB — snapshot the raw column as-is (it was already
      // normalized at save time).
      const v = (t as Record<string, unknown>)[col];
      if (v !== undefined) out[col] = v;
      continue;
    }
    const v = (t as Record<string, unknown>)[col];
    if (v !== undefined) out[col] = v;
  }
  return out;
}

/** Next version number for a template (max+1, first publish = 1). */
export async function nextTemplateVersion(
  store: Store,
  tenantId: string,
  templateId: string,
): Promise<number> {
  const list = await store.listTemplateVersions(tenantId, templateId);
  return list.length ? Math.max(...list.map((v) => v.version)) + 1 : 1;
}

/**
 * Snapshot the CURRENT stored state of a template as a new version.
 * Never throws to the caller — a snapshot failure must not fail the save
 * (warned loudly instead, the version list simply shows fewer entries).
 */
export async function publishTemplateVersion(
  store: Store,
  tenantId: string,
  templateId: string,
  changelog: string | null,
  createdBy: string | null,
): Promise<{ version: number } | null> {
  const t = await store.getDocumentTemplate(templateId);
  if (!t || t.tenant_id !== tenantId) return null;
  const version = await nextTemplateVersion(store, tenantId, templateId);
  await store.createTemplateVersion({
    tenant_id: tenantId,
    template_id: templateId,
    version,
    name: String(t.name || "template").slice(0, 200),
    snapshot: snapshotTemplateColumns(t),
    changelog: changelog ? changelog.slice(0, 500) : null,
    created_by: createdBy,
  });
  return { version };
}
