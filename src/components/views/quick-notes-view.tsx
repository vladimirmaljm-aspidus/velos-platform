"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Pin, PinOff, Trash2, Plus, Search, StickyNote } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { ModuleInfoTooltip } from "@/components/common/module-info-tooltip";

import { EmptyState } from "@/components/common/empty-state";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { fmtRelative } from "@/lib/utils/format";
import { useT } from "@/lib/i18n/store";

interface QuickNote { id: string; title: string; content: string; category: string; color: string; pinned: boolean; updated_at: string; }
const CATEGORY_LABELS: Record<string, string> = { general: "General", idea: "Idea", todo: "To-Do", meeting: "Meeting", call: "Call Notes", research: "Research" };
const CATEGORY_COLORS: Record<string, string> = { general: "#f59e0b", idea: "#8b5cf6", todo: "#3b82f6", meeting: "#ec4899", call: "#10b981", research: "#f97316" };

export function QuickNotesView() {
  const api = useApiUrl(); const tenantKey = useTenantKey(); const qc = useQueryClient();
  const [search, setSearch] = useState(""); const [editing, setEditing] = useState<QuickNote | null>(null); const [showForm, setShowForm] = useState(false);
  const t = useT();

  const { data, isLoading } = useQuery({
    queryKey: ["quick-notes", tenantKey],
    queryFn: async () => { const r = await fetch(api("/api/quick-notes")); if (!r.ok) throw new Error("Failed"); return r.json() as Promise<{ items: QuickNote[] }>; },
  });
  const saveMut = useMutation({
    mutationFn: async (note: any) => { const r = await fetch(api("/api/quick-notes"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(note) }); if (!r.ok) throw new Error("Save failed"); return r.json(); },
    onSuccess: () => { toast.success("Note saved."); qc.invalidateQueries({ queryKey: ["quick-notes", tenantKey] }); setShowForm(false); setEditing(null); },
    onError: () => toast.error("Failed to save."),
  });
  const deleteMut = useMutation({
    mutationFn: async (id: string) => { const r = await fetch(api(`/api/quick-notes/${id}`), { method: "DELETE" }); if (!r.ok) throw new Error("Delete failed"); },
    onSuccess: () => { toast.success("Deleted."); qc.invalidateQueries({ queryKey: ["quick-notes", tenantKey] }); },
  });
  const togglePin = (note: QuickNote) => saveMut.mutate({ ...note, pinned: !note.pinned });
  const notes = (data?.items || []).filter(n => !search || n.title?.toLowerCase().includes(search.toLowerCase()) || n.content?.toLowerCase().includes(search.toLowerCase()));
  const pinnedNotes = notes.filter(n => n.pinned); const regularNotes = notes.filter(n => !n.pinned);

  return (
    <div>
      <PageHeader title={t("quick-notes")} description={t("misc-quick-notes-desc")} />
      <ModuleInfoTooltip
        title="Quick Notes"
        description="Jot down quick notes and reminders. Pin important notes for easy access."
        howToUse={["Create a note with a title and body", "Pin notes to keep them on top", "Color-code notes by category", "Notes are private to you"]}
      />
      <div className="flex items-center gap-2 mb-4">
        <div className="relative flex-1"><Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" /><Input placeholder={t("misc-search-notes-placeholder")} value={search} onChange={e => setSearch(e.target.value)} className="pl-9" /></div>
        <Button onClick={() => { setEditing(null); setShowForm(true); }}><Plus className="size-4 mr-1" /> {t("misc-new-note")}</Button>
      </div>
      {isLoading ? <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-40 w-full rounded-xl" />)}</div>
      : notes.length === 0 ? <EmptyState icon={<StickyNote className="size-6" />} title={t("misc-no-notes-yet")} description={t("misc-create-first-note")} />
      : <div className="space-y-6">
          {pinnedNotes.length > 0 && <div><h3 className="text-sm font-semibold text-muted-foreground mb-2 flex items-center gap-1.5"><Pin className="size-3.5" /> {t("misc-pinned")}</h3><div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">{pinnedNotes.map(n => <NoteCard key={n.id} note={n} onEdit={() => { setEditing(n); setShowForm(true); }} onDelete={() => deleteMut.mutate(n.id)} onPin={() => togglePin(n)} />)}</div></div>}
          {regularNotes.length > 0 && <div><div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">{regularNotes.map(n => <NoteCard key={n.id} note={n} onEdit={() => { setEditing(n); setShowForm(true); }} onDelete={() => deleteMut.mutate(n.id)} onPin={() => togglePin(n)} />)}</div></div>}
        </div>}
      {showForm && <NoteForm note={editing} onClose={() => { setShowForm(false); setEditing(null); }} onSave={(d) => saveMut.mutate(d)} saving={saveMut.isPending} t={t} />}
    </div>
  );
}

function NoteCard({ note, onEdit, onDelete, onPin }: { note: QuickNote; onEdit: () => void; onDelete: () => void; onPin: () => void; }) {
  const color = note.color || CATEGORY_COLORS[note.category] || "#f59e0b";
  return <Card className="border-border/60 shadow-soft rounded-xl overflow-hidden cursor-pointer hover:shadow-md transition-shadow group" onClick={onEdit} style={{ borderTopWidth: 3, borderTopColor: color }}>
    <CardContent className="p-4"><div className="flex items-start justify-between gap-2 mb-2"><h4 className="font-semibold text-sm leading-tight line-clamp-2">{note.title || "Untitled"}</h4>
    <div className="flex items-center gap-0.5 shrink-0"><Button size="icon" variant="ghost" className="size-6 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => { e.stopPropagation(); onPin(); }}>{note.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}</Button><Button size="icon" variant="ghost" className="size-6 opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive" onClick={(e) => { e.stopPropagation(); onDelete(); }}><Trash2 className="size-3.5" /></Button></div></div>
    <p className="text-xs text-muted-foreground line-clamp-4 whitespace-pre-wrap">{note.content || "No content"}</p>
    <div className="flex items-center justify-between mt-3"><Badge variant="outline" className="text-xs" style={{ color, borderColor: `${color}40` }}>{CATEGORY_LABELS[note.category] || note.category}</Badge><span className="text-xs text-muted-foreground">{fmtRelative(note.updated_at)}</span></div></CardContent></Card>;
}

function NoteForm({ note, onClose, onSave, saving, t }: { note: QuickNote | null; onClose: () => void; onSave: (d: any) => void; saving: boolean; t: (key: string) => string; }) {
  const [title, setTitle] = useState(note?.title || ""); const [content, setContent] = useState(note?.content || ""); const [category, setCategory] = useState(note?.category || "general");
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}><Card className="w-full max-w-lg" onClick={e => e.stopPropagation()}><CardContent className="p-4 space-y-4">
    <Input placeholder={t("misc-note-title-placeholder")} value={title} onChange={e => setTitle(e.target.value)} className="font-semibold" />
    <div className="flex flex-wrap gap-2">{Object.entries(CATEGORY_LABELS).map(([code, label]) => <button key={code} onClick={() => setCategory(code)} className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${category === code ? "text-white border-transparent" : "border-border/60 text-muted-foreground hover:bg-muted"}`} style={category === code ? { backgroundColor: CATEGORY_COLORS[code] } : {}}>{label}</button>)}</div>
    <Textarea placeholder={t("misc-note-content-placeholder")} value={content} onChange={e => setContent(e.target.value)} rows={6} className="resize-none" />
    <div className="flex justify-end gap-2"><Button variant="outline" onClick={onClose}>{t("cancel")}</Button><Button onClick={() => onSave({ id: note?.id, title, content, category, color: CATEGORY_COLORS[category], pinned: note?.pinned })} disabled={saving}>{t("save")}</Button></div>
  </CardContent></Card></div>;
}
