"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Mail,
  Send,
  Copy,
  Save,
  Eye,
  Code,
  Variable,
  Languages,
  Search,
  Plus,
  Loader2,
  FileText,
  Sparkles,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import { useI18nStore } from "@/lib/i18n/store";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
// Locale type no longer needed

/* ─── Types ──────────────────────────────────────────────────────────────── */

type EmailCategory =
  | "transactional"
  | "marketing"
  | "notification"
  | "compliance";

interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  category: EmailCategory;
  variables: string[];
  description: string;
  html: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/* ─── Category Badge Config ──────────────────────────────────────────────── */

const CATEGORY_META: Record<
  EmailCategory,
  { label: string; className: string }
> = {
  transactional: {
    label: "Transactional",
    className:
      "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
  },
  marketing: {
    label: "Marketing",
    className:
      "bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/20",
  },
  notification: {
    label: "Notification",
    className:
      "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
  },
  compliance: {
    label: "Compliance",
    className:
      "bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20",
  },
};

/* ─── i18n Labels ────────────────────────────────────────────────────────── */

const LABELS: Record<string, string> = {
    title: "Email Templates",
    description: "Manage and preview email templates for all communications.",
    search: "Search templates…",
    templates: "Templates",
    editor: "Editor",
    preview: "Preview",
    variables: "Variables",
    subject: "Subject",
    body: "HTML Body",
    templateName: "Template Name",
    sendTest: "Send Test Email",
    save: "Save",
    copyVar: "Copy variable",
    copied: "Copied!",
    noSelection: "Select a Template",
    noSelectionDesc:
      "Choose a template from the list to start editing and previewing.",
    language: "Language",
    english: "English",
    default: "Default",
    custom: "Custom",
    lastUpdated: "Updated",
    category: "Category",
    all: "All",
    newTemplate: "New Template",
    createTemplate: "Create Template",
    saving: "Saving…",
    sending: "Sending…",
    testSent: "Test email sent successfully!",
    testSentDesc: "Check your inbox for the test email.",
    saved: "Template saved!",
    variableHint: "Use {{variable}} syntax in subject and body.",
    previewLabel: "Live Preview",
    codeView: "Code",
    visualView: "Visual",
    cancel: "Cancel",

};

/* ─── Helper: Highlight Variables in Subject ─────────────────────────────── */

function highlightVariables(text: string) {
  const parts = text.split(/(\{\{[^}]+\}\})/g);
  return parts.map((part, i) => {
    if (/^\{\{[^}]+\}\}$/.test(part)) {
      return (
        <span
          key={i}
          className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 rounded px-1 py-0.5 text-xs font-mono font-medium"
        >
          {part}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

/* ─── Main Component ─────────────────────────────────────────────────────── */

export function EmailTemplatesView() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const locale = useI18nStore((s) => s.locale);
  const t = (key: string) => LABELS[key] || key;

  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editLang, setEditLang] = useState<string>("en");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [showNewDialog, setShowNewDialog] = useState(false);

  // Fetch templates
  const { data, isLoading } = useQuery({
    queryKey: ["email-templates", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/email-templates"));
      if (!r.ok) throw new Error("Failed to load email templates");
      return r.json() as Promise<{ templates: EmailTemplate[] }>;
    },
  });

  const templates = data?.templates ?? [];
  const selected = selectedId
    ? templates.find((tpl) => tpl.id === selectedId) ?? null
    : null;

  // Filter templates
  const filtered = useMemo(() => {
    let list = templates;
    if (categoryFilter !== "all") {
      list = list.filter((tpl) => tpl.category === categoryFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (tpl) =>
          tpl.name.toLowerCase().includes(q) ||
          tpl.description.toLowerCase().includes(q)
      );
    }
    return list;
  }, [templates, categoryFilter, search]);

  return (
    <div>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Button onClick={() => setShowNewDialog(true)}>
            <Plus className="size-4 mr-1" /> {t("newTemplate")}
          </Button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* ─── Left: Template List ─────────────────────────────── */}
        <div className="lg:col-span-4 xl:col-span-3 space-y-4">
          {/* Search & Filter */}
          <Card className="border-border/60 shadow-soft">
            <CardContent className="p-3 space-y-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                <Input
                  placeholder={t("search")}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
              <Select
                value={categoryFilter}
                onValueChange={setCategoryFilter}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t("category")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("all")}</SelectItem>
                  <SelectItem value="transactional">
                    {CATEGORY_META.transactional.label}
                  </SelectItem>
                  <SelectItem value="marketing">
                    {CATEGORY_META.marketing.label}
                  </SelectItem>
                  <SelectItem value="notification">
                    {CATEGORY_META.notification.label}
                  </SelectItem>
                  <SelectItem value="compliance">
                    {CATEGORY_META.compliance.label}
                  </SelectItem>
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          {/* Template List */}
          <Card className="border-border/60 shadow-soft">
            <CardHeader className="px-4 pt-4 pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Mail className="size-4" /> {t("templates")}
                <Badge variant="secondary" className="ml-auto text-xs">
                  {filtered.length}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {isLoading ? (
                <div className="p-4 space-y-3">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="space-y-2">
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="h-3 w-1/2" />
                      <Skeleton className="h-3 w-full" />
                    </div>
                  ))}
                </div>
              ) : filtered.length === 0 ? (
                <div className="p-6">
                  <EmptyState
                    icon={<Mail className="size-6" />}
                    title={"No templates"}
                    description={
                      "No templates match the current filter."
                    }
                  />
                </div>
              ) : (
                <ScrollArea className="max-h-[calc(100vh-320px)]">
                  <div className="px-2 pb-2 space-y-1">
                    {filtered.map((tpl) => {
                      const catMeta = CATEGORY_META[tpl.category];
                      const isSelected = selectedId === tpl.id;
                      const name =
                        tpl.name;
                      const desc =
                        tpl.description;

                      return (
                        <button
                          key={tpl.id}
                          className={`w-full text-left rounded-lg p-3 transition-colors smooth group ${
                            isSelected
                              ? "bg-emerald-500/10 border border-emerald-500/30"
                              : "hover:bg-muted/50 border border-transparent"
                          }`}
                          onClick={() => setSelectedId(tpl.id)}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium truncate">
                                  {name}
                                </span>
                                {tpl.isDefault && (
                                  <Badge
                                    variant="outline"
                                    className="text-[10px] px-1.5 py-0 h-4 shrink-0"
                                  >
                                    {t("default")}
                                  </Badge>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                                {desc}
                              </p>
                            </div>
                            <ChevronRight
                              className={`size-4 shrink-0 mt-0.5 transition-colors ${
                                isSelected
                                  ? "text-emerald-600 dark:text-emerald-400"
                                  : "text-muted-foreground/40"
                              }`}
                            />
                          </div>
                          <div className="flex items-center gap-1.5 mt-2">
                            <Badge
                              variant="outline"
                              className={`text-[10px] px-1.5 py-0 h-4 ${catMeta.className}`}
                            >
                              {catMeta.label}
                            </Badge>
                            <span className="text-[10px] text-muted-foreground ml-auto">
                              {tpl.variables.length}{" "}
                              {"vars"}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </ScrollArea>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ─── Right: Editor + Preview ─────────────────────────── */}
        <div className="lg:col-span-8 xl:col-span-9">
          {selected ? (
            <TemplateEditorPanel
              key={`${selected.id}-${editLang}`}
              template={selected}
              editLang={editLang}
              locale={locale}
              t={t}
              onEditLangChange={setEditLang}
            />
          ) : (
            <Card className="border-border/60 shadow-soft">
              <CardContent className="p-0">
                <EmptyState
                  icon={<FileText className="size-6" />}
                  title={t("noSelection")}
                  description={t("noSelectionDesc")}
                  action={
                    <Button
                      variant="outline"
                      onClick={() => {
                        if (filtered.length > 0) {
                          setSelectedId(filtered[0].id);
                        }
                      }}
                    >
                      <Sparkles className="size-4 mr-1" />{" "}
                      {"Select first template"}
                    </Button>
                  }
                />
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* ─── New Template Dialog ──────────────────────────────────── */}
      <NewTemplateDialog
        open={showNewDialog}
        onOpenChange={setShowNewDialog}
        locale={locale}
        t={t}
        onCreated={(id) => {
          setShowNewDialog(false);
          setSelectedId(id);
          qc.invalidateQueries({ queryKey: ["email-templates", tenantKey] });
        }}
      />
    </div>
  );
}

/* ─── Template Editor Panel (keyed to reset state on selection change) ── */

function TemplateEditorPanel({
  template,
  editLang,
  locale,
  t,
  onEditLangChange,
}: {
  template: EmailTemplate;
  editLang: string;
  locale: string;
  t: (key: string) => string;
  onEditLangChange: (l: string) => void;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const qc = useQueryClient();
  const [previewMode, setPreviewMode] = useState<"visual" | "code">("visual");

  // Initialize editor state from template — no effect needed because
  // this component is keyed by `${selected.id}-${editLang}`
  const [editName, setEditName] = useState(
    template.name
  );
  const [editSubject, setEditSubject] = useState(
    template.subject
  );
  const [editBody, setEditBody] = useState(
    template.html
  );

  // Save mutation
  const saveMut = useMutation({
    mutationFn: async (payload: Partial<EmailTemplate> & { id?: string }) => {
      const r = await fetch(api("/api/email-templates"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error("Failed to save template");
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("saved"));
      qc.invalidateQueries({ queryKey: ["email-templates", tenantKey] });
    },
    onError: () => toast.error("Failed to save template."),
  });

  // Test send mutation
  const testSendMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(api("/api/email-templates"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "test-send",
          templateId: template.id,
        }),
      });
      if (!r.ok) throw new Error("Failed to send test email");
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("testSent"), { description: t("testSentDesc") });
    },
    onError: () => toast.error("Failed to send test email."),
  });

  const handleSave = useCallback(() => {
    if (!editName.trim()) {
      toast.error("Template name is required.");
      return;
    }
    saveMut.mutate({
      id: template.id,
      name: editName,
      subject: editSubject,
      html: editBody,
      category: template.category,
      variables: template.variables,
      description: template.description,
    });
  }, [template, editName, editSubject, editBody, saveMut]);

  const handleCopyVariable = useCallback(
    (variable: string) => {
      navigator.clipboard.writeText(`{{${variable}}}`);
      toast.success(t("copied"));
    },
    [t]
  );

  return (
    <div className="space-y-4">
      {/* Language Toggle + Actions Bar */}
      <Card className="border-border/60 shadow-soft">
        <CardContent className="p-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <Languages className="size-4 text-muted-foreground" />
              <span className="text-xs font-medium text-muted-foreground">
                {t("language")}:
              </span>
            </div>
            <div className="inline-flex rounded-lg border border-border/60 p-[2px]">
              <button
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                  editLang === "en"
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => onEditLangChange("en")}
              >
                {t("english")}
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => testSendMut.mutate()}
              disabled={testSendMut.isPending}
            >
              {testSendMut.isPending ? (
                <Loader2 className="size-4 mr-1 animate-spin" />
              ) : (
                <Send className="size-4 mr-1" />
              )}
              {testSendMut.isPending ? t("sending") : t("sendTest")}
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saveMut.isPending}
            >
              {saveMut.isPending ? (
                <Loader2 className="size-4 mr-1 animate-spin" />
              ) : (
                <Save className="size-4 mr-1" />
              )}
              {saveMut.isPending ? t("saving") : t("save")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Main Editor + Preview */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* Editor Panel */}
        <Card className="border-border/60 shadow-soft">
          <CardHeader className="px-4 pt-4 pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Code className="size-4" /> {t("editor")}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-4">
            {/* Template Name */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">
                {t("templateName")}
              </Label>
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                readOnly={template.isDefault}
                className={
                  template.isDefault ? "bg-muted/50 cursor-not-allowed" : ""
                }
              />
            </div>

            {/* Category Badge */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {t("category")}:
              </span>
              <Badge
                variant="outline"
                className={CATEGORY_META[template.category].className}
              >
                {CATEGORY_META[template.category].label}
              </Badge>
            </div>

            {/* Subject */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t("subject")}</Label>
              <Input
                value={editSubject}
                onChange={(e) => setEditSubject(e.target.value)}
                placeholder="Subject line with {{variables}}"
              />
              {editSubject && (
                <div className="text-xs text-muted-foreground mt-1">
                  {highlightVariables(editSubject)}
                </div>
              )}
            </div>

            {/* Body */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t("body")}</Label>
              <Textarea
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
                rows={14}
                className="font-mono text-xs leading-relaxed resize-none"
                placeholder="<div>HTML content with {{variables}}</div>"
              />
            </div>

            <Separator />

            {/* Variables Panel */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Variable className="size-4 text-muted-foreground" />
                <span className="text-xs font-semibold">
                  {t("variables")}
                </span>
                <Badge
                  variant="secondary"
                  className="text-[10px] ml-auto"
                >
                  {template.variables.length}
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t("variableHint")}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {template.variables.map((v) => (
                  <button
                    key={v}
                    className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-xs font-mono text-foreground hover:bg-emerald-500/10 hover:border-emerald-500/30 hover:text-emerald-700 dark:hover:text-emerald-400 transition-colors smooth"
                    onClick={() => handleCopyVariable(v)}
                    title={t("copyVar")}
                  >
                    <span>{`{{${v}}}`}</span>
                    <Copy className="size-3 text-muted-foreground" />
                  </button>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Preview Panel */}
        <Card className="border-border/60 shadow-soft">
          <CardHeader className="px-4 pt-4 pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Eye className="size-4" /> {t("previewLabel")}
              </CardTitle>
              <div className="inline-flex rounded-md border border-border/60 p-[2px]">
                <button
                  className={`px-2 py-0.5 text-[11px] font-medium rounded transition-colors ${
                    previewMode === "visual"
                      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setPreviewMode("visual")}
                >
                  {t("visualView")}
                </button>
                <button
                  className={`px-2 py-0.5 text-[11px] font-medium rounded transition-colors ${
                    previewMode === "code"
                      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setPreviewMode("code")}
                >
                  {t("codeView")}
                </button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {/* Subject Preview */}
            <div className="mb-3 p-3 rounded-lg bg-muted/30 border border-border/40">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold mb-1">
                {t("subject")}
              </p>
              <p className="text-sm font-medium">
                {highlightVariables(editSubject)}
              </p>
            </div>

            {/* Preview Content */}
            {previewMode === "visual" ? (
              <div className="rounded-lg border border-border/40 overflow-hidden bg-white">
                <div className="bg-muted/30 px-3 py-1.5 border-b border-border/40 flex items-center gap-2">
                  <div className="flex gap-1">
                    <div className="size-2 rounded-full bg-red-400/60" />
                    <div className="size-2 rounded-full bg-amber-400/60" />
                    <div className="size-2 rounded-full bg-emerald-400/60" />
                  </div>
                  <span className="text-[10px] text-muted-foreground ml-1">
                    {"Preview"}
                  </span>
                </div>
                <iframe
                  srcDoc={editBody}
                  className="w-full min-h-[400px] border-0"
                  title="Email Preview"
                  sandbox="allow-same-origin"
                />
              </div>
            ) : (
              <div className="rounded-lg border border-border/40 bg-muted/30 p-3 max-h-[460px] overflow-y-auto custom-scroll">
                <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap break-all text-foreground/80">
                  {editBody || "(empty)"}
                </pre>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/* ─── New Template Dialog ─────────────────────────────────────────────── */

function NewTemplateDialog({
  open,
  onOpenChange,
  locale,
  t,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  locale: string;
  t: (key: string) => string;
  onCreated: (id: string) => void;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState<EmailCategory>("transactional");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      setName("");
      setSubject("");
      setCategory("transactional");
      setDescription("");
    }
  }, [open]);

  async function handleCreate() {
    if (!name.trim()) {
      toast.error("Template name is required.");
      return;
    }
    setSaving(true);
    try {
      const r = await fetch(api("/api/email-templates"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          subject: subject.trim(),
          category,
          description: description.trim(),
          html: "",
          variables: [],
        }),
      });
      if (!r.ok) throw new Error("Failed to create template");
      const result = await r.json();
      toast.success(t("saved"));
      onCreated(result.template?.id ?? `tpl-${Date.now()}`);
    } catch {
      toast.error("Failed to create template.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="size-5" /> {t("createTemplate")}
          </DialogTitle>
          <DialogDescription>
            {"Create a new email template."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Template name"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Subject</Label>
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject line with {{variables}}"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">{t("category")}</Label>
            <Select
              value={category}
              onValueChange={(v) => setCategory(v as EmailCategory)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="transactional">
                  {CATEGORY_META.transactional.label}
                </SelectItem>
                <SelectItem value="marketing">
                  {CATEGORY_META.marketing.label}
                </SelectItem>
                <SelectItem value="notification">
                  {CATEGORY_META.notification.label}
                </SelectItem>
                <SelectItem value="compliance">
                  {CATEGORY_META.compliance.label}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Description</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="When is this template used?"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button onClick={handleCreate} disabled={saving}>
            {saving ? (
              <Loader2 className="size-4 mr-1 animate-spin" />
            ) : (
              <Plus className="size-4 mr-1" />
            )}
            {saving ? t("saving") : t("createTemplate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
