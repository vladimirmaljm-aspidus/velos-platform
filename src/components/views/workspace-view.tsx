"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Bell, Clock, Receipt, FileText, MessageSquare, FolderOpen, KanbanSquare, CalendarClock } from "lucide-react";
import { PageHeader } from "@/components/common/page-header";
import { useT } from "@/lib/i18n/store";

const PLANNED = [
  { icon: Bell, label: "Reminders", desc: "Personal to-do reminders with due dates and priority." },
  { icon: Clock, label: "Time Tracker", desc: "Start/stop timers against deals and tasks; weekly reports." },
  { icon: Receipt, label: "Expenses", desc: "Log expenses, attach receipts, export for accounting." },
  { icon: FileText, label: "Meeting Notes", desc: "Structured notes linked to partners and deals." },
  { icon: MessageSquare, label: "Team Chat", desc: "Internal chat with @mentions and per-channel history." },
  { icon: FolderOpen, label: "File Manager", desc: "Shared file drive with folder tagging." },
  { icon: KanbanSquare, label: "Project Tasks", desc: "Kanban board for cross-team project delivery." },
];

export function WorkspaceView() {
  const t = useT();
  return (
    <div>
      <PageHeader
        title={t("workspace")}
        description={t("misc-workspace-desc")}
      />
      <Card className="border-dashed">
        <CardContent className="p-8 space-y-6">
          <div className="flex items-start gap-4">
            <div className="size-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <CalendarClock className="size-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold">{t("misc-coming-soon")}</h2>
                <Badge variant="outline" className="text-xs">{t("misc-in-development")}</Badge>
              </div>
              <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
                {t("misc-workspace-intro")} <strong>{t("tasks")}</strong> {t("misc-workspace-for-todos")} <strong>{t("quick-notes")}</strong> {t("misc-workspace-for-notes")}.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 pt-2">
            {PLANNED.map((p, idx) => {
              const Icon = p.icon;
              const labelKey = ["misc-planned-reminders", "misc-planned-time-tracker", "misc-planned-expenses", "misc-planned-meeting-notes", "misc-planned-team-chat", "misc-planned-file-manager", "misc-planned-project-tasks"][idx] || "misc-coming-soon";
              const descKey = `${labelKey}-desc`;
              return (
                <div key={p.label} className="flex items-start gap-3 p-3 rounded-lg border border-border/60 bg-muted/20">
                  <div className="size-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                    <Icon className="size-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{t(labelKey)}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{t(descKey)}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
