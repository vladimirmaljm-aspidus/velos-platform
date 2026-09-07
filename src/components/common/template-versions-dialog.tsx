"use client";

/**
 * TemplateVersionsDialog — Document Studio version history (audit35).
 *
 * • Publish: snapshots the CURRENT stored state as a new version (with an
 *   optional changelog). The editor refuses to publish a dirty form — you
 *   can never snapshot changes that weren't saved.
 * • Restore: writes a snapshot back. The current state is auto-snapshotted
 *   server-side first, so every restore is reversible.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { History, Loader2, RotateCcw, Upload, FileClock } from "lucide-react";
import { useApiUrl } from "@/lib/hooks/use-api-url";
import { useT } from "@/lib/i18n/store";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { DocumentTemplate, TemplateVersionSummary } from "@/lib/supabase/types";

export function TemplateVersionsDialog({
  open, onOpenChange, template, onRestored, dirty,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  template: DocumentTemplate | null;
  /** Called after a successful restore with the restored template. */
  onRestored: (t: DocumentTemplate) => void;
  /** Blocks publishing while the editor has unsaved changes. */
  dirty: boolean;
}) {
  const api = useApiUrl();
  const t = useT();
  const [versions, setVersions] = useState<TemplateVersionSummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [changelog, setChangelog] = useState("");

  const load = useCallback(async () => {
    if (!template) return;
    try {
      const r = await fetch(api(`/api/document-templates/${template.id}/versions`));
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setVersions(d.items ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("doc-versions-load-failed"));
      setVersions([]);
    }
  }, [template, api, t]);

  // Open → fetch the list (setState after the await — never synchronously
  // inside the effect body).
  useEffect(() => {
    if (!open || !template) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(api(`/api/document-templates/${template.id}/versions`));
        const d = await r.json().catch(() => ({}));
        if (!cancelled) setVersions(r.ok ? d.items ?? [] : []);
      } catch {
        if (!cancelled) setVersions([]);
      }
    })();
    return () => { cancelled = true; };
  }, [open, template, api]);

  async function publish() {
    if (!template) return;
    if (dirty) {
      toast.info(t("doc-publish-save-first"));
      return;
    }
    setBusy("publish");
    try {
      const r = await fetch(api(`/api/document-templates/${template.id}/versions`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "publish", changelog: changelog.trim() || null }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      toast.success(`${t("doc-publish-success")} v${d.version}`);
      setChangelog("");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("doc-publish-failed"));
    } finally {
      setBusy(null);
    }
  }

  async function restore(version: number) {
    if (!template) return;
    if (!window.confirm(`${t("doc-restore-confirm")} v${version}?`)) return;
    setBusy(`restore-${version}`);
    try {
      const r = await fetch(api(`/api/document-templates/${template.id}/versions`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restore", version }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      toast.success(`${t("doc-restore-success")} v${version}`);
      onRestored(d.template as DocumentTemplate);
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("doc-restore-failed"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <History className="size-5" />
          </div>
          <div className="min-w-0">
            <DialogTitle className="text-base leading-tight">{t("doc-versions-title")}</DialogTitle>
            <DialogDescription className="truncate text-xs">{template?.name}</DialogDescription>
          </div>
        </div>

        {/* Publish current version */}
        <div className="space-y-2 rounded-lg border border-border/60 p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Upload className="size-4 text-primary" />
            {t("doc-publish-current")}
          </div>
          <div className="flex gap-2">
            <Input
              value={changelog}
              onChange={(e) => setChangelog(e.target.value)}
              placeholder={t("doc-publish-changelog")}
              maxLength={500}
              className="h-8 text-sm"
            />
            <Button size="sm" className="h-8" onClick={publish} disabled={busy === "publish" || dirty}>
              {busy === "publish" ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
              <span className="ml-1">{t("doc-publish")}</span>
            </Button>
          </div>
          {dirty && <p className="text-xs text-amber-600 dark:text-amber-400">{t("doc-publish-dirty-hint")}</p>}
          <p className="text-xs text-muted-foreground">{t("doc-publish-note")}</p>
        </div>

        {/* Version list */}
        <div className="space-y-1.5">
          <div className="text-sm font-medium">{t("doc-versions-list")}</div>
          {versions === null ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : !versions || versions.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <FileClock className="size-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">{t("doc-no-versions")}</p>
            </div>
          ) : (
            <ScrollArea className="max-h-64">
              <div className="space-y-1.5 pr-2">
                {versions.map((v) => (
                  <div
                    key={v.id}
                    className={cn(
                      "flex items-center gap-3 rounded-md border border-border/60 px-3 py-2",
                      busy === `restore-${v.version}` && "opacity-60",
                    )}
                  >
                    <Badge variant="outline" className="tabular">v{v.version}</Badge>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{v.name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {new Date(v.created_at).toLocaleString()}
                        {v.changelog ? ` — ${v.changelog}` : ""}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 shrink-0 text-xs"
                      onClick={() => restore(v.version)}
                      disabled={busy !== null}
                    >
                      {busy === `restore-${v.version}` ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="size-3.5" />
                      )}
                      <span className="ml-1">{t("doc-restore")}</span>
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
          <p className="text-[11px] text-muted-foreground">{t("doc-restore-auto-backup")}</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
