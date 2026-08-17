"use client";

import React, { useState, useMemo } from "react";
import { useNewShortcut } from "@/lib/hooks/use-new-shortcut";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card, CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Pencil, Trash2, ListChecks, CheckCircle2, Link2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { fmtDate, fmtRelative, fmtNumber, fmtMoney } from "@/lib/utils/format";
import { UserTask } from "@/lib/supabase/types";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useT } from "@/lib/i18n/store";

type Priority = "low" | "medium" | "high";

const PRIORITY_LABEL: Record<Priority, string> = {
  low: "misc-priority-low", medium: "misc-priority-medium", high: "misc-priority-high",
};

const PRIORITY_BADGE: Record<Priority, string> = {
  high: "border-transparent bg-destructive text-white",
  medium: "border-transparent bg-chart-4 text-white",
  low: "border-transparent bg-secondary text-secondary-foreground",
};

function isPast(iso: string | null): boolean {
  if (!iso) return false;
  return new Date(iso).getTime() < Date.now();
}

function toInputDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function TasksView() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const qc = useQueryClient();
  const [mine, setMine] = useState(true);
  const [editing, setEditing] = useState<UserTask | null>(null);
  const [showForm, setShowForm] = useState(false);
  useNewShortcut(() => { setEditing(null); setShowForm(true); });
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const queryKey = useMemo(() => ["tasks", tenantKey, mine] as const, [mine, tenantKey]);

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: async () => {
      const url = mine ? api("/api/tasks?mine=true") : api("/api/tasks");
      const r = await fetch(url);
      if (!r.ok) throw new Error(t("misc-toast-load-tasks-failed"));
      return r.json() as Promise<{ items: UserTask[] }>;
    },
  });

  const items = data?.items || [];
  const active = items.filter((t) => !t.done);
  const done = items.filter((t) => t.done);

  const toggleMut = useMutation({
    mutationFn: async ({ id, done }: { id: string; done: boolean }) => {
      const r = await fetch(api(`/api/tasks/${id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ done }),
      });
      if (!r.ok) throw new Error(t("misc-toast-task-update-failed"));
      return r.json();
    },
    onMutate: async ({ id, done }) => {
      await qc.cancelQueries({ queryKey });
      const prev = qc.getQueryData<{ items: UserTask[] }>(queryKey);
      if (prev) {
        qc.setQueryData<{ items: UserTask[] }>(queryKey, {
          items: prev.items.map((t) => (t.id === id ? { ...t, done } : t)),
        });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKey, ctx.prev);
      toast.error(t("misc-toast-task-update-failed"));
    },
    onSettled: () => qc.invalidateQueries({ queryKey }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(api(`/api/tasks/${id}`), { method: "DELETE" });
      if (!r.ok) throw new Error(t("misc-toast-task-delete-failed"));
    },
    onSuccess: () => {
      toast.success(t("misc-toast-task-deleted"));
      qc.invalidateQueries({ queryKey });
      setDeleteId(null);
    },
    onError: () => toast.error(t("misc-toast-task-delete-failed")),
  });

  return (
    <div>
      <PageHeader
        title={t("tasks")}
        description={t("misc-tasks-count-summary").replace("{active}", String(active.length)).replace("{done}", String(done.length))}
        actions={
          <>
            <label className="flex items-center gap-2 text-sm text-muted-foreground mr-1">
              <Switch checked={mine} onCheckedChange={setMine} aria-label={t("misc-only-mine")} />
              {t("misc-only-mine")}
            </label>
            <Button onClick={() => { setEditing(null); setShowForm(true); }}>
              <Plus className="size-4 mr-1" /> {t("misc-new-task")}
            </Button>
          </>
        }
      />

      {isLoading ? (
        <div className="grid md:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="border-border/60 shadow-soft rounded-xl">
              <CardContent className="p-4"><Skeleton className="h-16 w-full" /></CardContent>
            </Card>
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<ListChecks className="size-6" />}
          title={t("misc-no-tasks")}
          description={t("misc-no-tasks-desc")}
          action={<Button onClick={() => { setEditing(null); setShowForm(true); }}><Plus className="size-4 mr-1" /> {t("misc-new-task")}</Button>}
        />
      ) : (
        <div className="grid md:grid-cols-2 gap-4">
          <TaskColumn
            title={t("active")}
            icon={<ListChecks className="size-4" />}
            count={active.length}
            tasks={active}
            onToggle={(t) => toggleMut.mutate({ id: t.id, done: !t.done })}
            onEdit={(t) => { setEditing(t); setShowForm(true); }}
            onDelete={(t) => setDeleteId(t.id)}
          />
          <TaskColumn
            title={t("completed")}
            icon={<CheckCircle2 className="size-4" />}
            count={done.length}
            tasks={done}
            onToggle={(t) => toggleMut.mutate({ id: t.id, done: !t.done })}
            onEdit={(t) => { setEditing(t); setShowForm(true); }}
            onDelete={(t) => setDeleteId(t.id)}
          />
        </div>
      )}

      <TaskFormDialog
        open={showForm}
        onOpenChange={setShowForm}
        task={editing}
        onSaved={() => {
          setShowForm(false);
          qc.invalidateQueries({ queryKey });
        }}
      />

      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("misc-delete-task-confirm")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("misc-action-cannot-be-undone")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteId && deleteMut.mutate(deleteId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function TaskColumn({
  title, icon, count, tasks, onToggle, onEdit, onDelete,
}: {
  title: string;
  icon: React.ReactNode;
  count: number;
  tasks: UserTask[];
  onToggle: (t: UserTask) => void;
  onEdit: (t: UserTask) => void;
  onDelete: (t: UserTask) => void;
}) {
  const t = useT();
  return (
    <div>
      <div className="flex items-center gap-2 mb-3 px-1">
        <span className="text-muted-foreground">{icon}</span>
        <h2 className="text-sm font-semibold uppercase tracking-wide">{title}</h2>
        <Badge variant="secondary" className="ml-1 tabular">{fmtNumber(count)}</Badge>
      </div>
      <div className="space-y-2 max-h-[calc(100vh-280px)] overflow-y-auto custom-scroll pr-1">
        {tasks.length === 0 ? (
          <Card className="border-border/60 shadow-soft rounded-xl">
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              {t("misc-no-tasks-here")}
            </CardContent>
          </Card>
        ) : (
          tasks.map((task) => (
            <Card
              key={task.id}
              className="border-border/60 shadow-soft rounded-xl hover:shadow-soft-md transition-shadow"
            >
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <Checkbox
                    checked={task.done}
                    onCheckedChange={() => onToggle(task)}
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className={`text-sm font-medium ${task.done ? "line-through text-muted-foreground" : ""}`}>
                        {task.title}
                      </p>
                      <Badge className={PRIORITY_BADGE[task.priority]}>
                        {t(PRIORITY_LABEL[task.priority])}
                      </Badge>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>
                        {t("misc-due-label")}{" "}
                        <span className={`tabular ${isPast(task.due_date) && !task.done ? "text-destructive font-medium" : ""}`}>
                          {fmtDate(task.due_date)}
                        </span>
                      </span>
                      <span className="tabular">{t("misc-created-label")} {fmtRelative(task.created_at)}</span>
                      {task.entity_type && task.entity_id && (
                        <span className="inline-flex items-center gap-1 font-mono">
                          <Link2 className="size-3" />
                          {task.entity_type}:{task.entity_id.slice(0, 8)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button size="icon" variant="ghost" className="size-8" onClick={() => onEdit(task)} title={t("edit")}>
                      <Pencil className="size-4" />
                    </Button>
                    <Button size="icon" variant="ghost" className="size-8 text-destructive" onClick={() => onDelete(task)} title={t("delete")}>
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}

function TaskFormDialog({
  open, onOpenChange, task, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  task: UserTask | null;
  onSaved: () => void;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [dueDate, setDueDate] = useState("");
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);

  React.useEffect(() => {
    if (open) {
      setTitle(task?.title || "");
      setPriority((task?.priority as Priority) || "medium");
      setDueDate(toInputDate(task?.due_date || null));
      setDone(!!task?.done);
    }
  }, [open, task]);

  async function save() {
    if (!title.trim()) { toast.error(t("misc-toast-enter-title")); return; }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        title: title.trim(),
        priority,
        done,
      };
      if (dueDate) body.due_date = new Date(dueDate).toISOString();
      else body.due_date = null;

      // preserve entity link if editing
      if (task?.entity_type) body.entity_type = task.entity_type;
      if (task?.entity_id) body.entity_id = task.entity_id;

      const method = task ? "PUT" : "POST";
      const url = task ? api(`/api/tasks/${task.id}`) : api("/api/tasks");
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || t("misc-toast-task-save-failed"));
      }
      toast.success(task ? t("misc-toast-task-updated") : t("misc-toast-task-created"));
      onSaved();
    } catch (e: any) {
      toast.error(e.message || t("misc-toast-task-save-failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{task ? t("misc-edit-task") : t("misc-new-task")}</DialogTitle>
          <DialogDescription>{t("misc-task-form-desc")}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] overflow-y-auto pr-1">
        <div className="grid gap-3 py-2">
          <div className="space-y-1.5">
            <Label>{t("misc-title-required")}</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("misc-task-title-placeholder")} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("misc-priority-label")}</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as Priority)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">{t("misc-priority-low")}</SelectItem>
                  <SelectItem value="medium">{t("misc-priority-medium")}</SelectItem>
                  <SelectItem value="high">{t("misc-priority-high")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("misc-due-date")}</Label>
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
          </div>

          <div className="flex items-center justify-between p-3 rounded-md bg-muted/30">
            <div>
              <p className="text-sm font-medium">{t("misc-done-label")}</p>
              <p className="text-xs text-muted-foreground">{t("misc-mark-completed-desc")}</p>
            </div>
            <Switch checked={done} onCheckedChange={setDone} aria-label={t("misc-done-label")} />
          </div>
        </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? t("misc-saving") : t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
