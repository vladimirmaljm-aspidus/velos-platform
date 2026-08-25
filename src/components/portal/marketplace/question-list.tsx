"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Loader2,
  Plus,
  Search,
  MessageSquare,
  CheckCircle2,
  Eye,
  Send,
} from "lucide-react";
import { toast } from "sonner";
import { useT } from "@/lib/i18n/store";
import { useAppStore } from "@/lib/store/app-store";
import type { Question, Answer } from "@/lib/supabase/marketplace-community-types";

interface ListResponse {
  items: Question[];
  total: number;
}

interface AnswersResponse {
  items: Answer[];
}

/**
 * Q&A list. Each card surfaces: title, snippet of body, tags, view count,
 * answer count, and an "answered" indicator (CheckCircle2) when an
 * accepted answer exists.
 *
 * FIX-MARKET-UI / FIX 2 — added "View answers" link per row that opens a
 * dialog with the answers list + an inline answer composer. The dialog
 * also lets the user accept an answer.
 *
 * Filter bar: search (title/body), tag filter (typed free-text),
 * unanswered toggle.
 */
export function QuestionList({ onCreateClick }: { onCreateClick?: () => void }) {
  const t = useT();
  const setSelectedId = useAppStore((s) => s.setSelectedId);
  void setSelectedId; // (kept for callers — no view-switch on row click in v2)
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState("");
  const [unanswered, setUnanswered] = useState(false);
  // FIX-MARKET-UI / FIX 2 — the question whose answers are open in the modal.
  const [openQuestion, setOpenQuestion] = useState<Question | null>(null);

  const qp = new URLSearchParams({ limit: "24" });
  if (search.trim()) qp.set("search", search.trim());
  if (tag.trim()) qp.set("tag", tag.trim());
  if (unanswered) qp.set("unanswered", "1");

  const q = useQuery<ListResponse>({
    queryKey: ["community-questions", search, tag, unanswered],
    queryFn: async () => {
      const r = await fetch(`/api/marketplace/questions?${qp}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });

  const items = q.data?.items ?? [];
  const total = q.data?.total ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("marketplace-community-questions-search-placeholder")}
            className="pl-9"
          />
        </div>
        <Input
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          placeholder={t("marketplace-community-tag-placeholder")}
          className="sm:w-44"
        />
        <Button
          variant={unanswered ? "default" : "outline"}
          onClick={() => setUnanswered((v) => !v)}
          className="gap-1.5"
        >
          <MessageSquare className="h-4 w-4" />
          {t("marketplace-community-unanswered")}
        </Button>
        {onCreateClick && (
          <Button onClick={onCreateClick} className="gap-1.5">
            <Plus className="h-4 w-4" />
            {t("marketplace-community-ask-question")}
          </Button>
        )}
      </div>

      {q.isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : q.isError ? (
        <div className="text-center py-12 text-sm text-muted-foreground">
          {t("marketplace-community-load-error")}
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-sm text-muted-foreground">
          {t("marketplace-community-questions-empty")}
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {t("marketplace-community-results-count").replace("{n}", String(total))}
          </p>
          <div className="space-y-3">
            {items.map((q) => (
              <Card key={q.id} className="hover:shadow-soft transition-shadow">
                <CardContent className="p-4 space-y-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        {q.is_answered && (
                          <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                        )}
                        <h3 className="font-medium text-sm truncate">{q.title}</h3>
                      </div>
                      {q.body && (
                        <p className="text-sm text-muted-foreground line-clamp-2">{q.body}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                      <span className="inline-flex items-center gap-1">
                        <Eye className="h-3.5 w-3.5" />
                        {q.views_count}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <MessageSquare className="h-3.5 w-3.5" />
                        {q.answers_count}
                      </span>
                    </div>
                  </div>
                  {Array.isArray(q.tags) && q.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                      {q.tags.slice(0, 8).map((tag) => (
                        <Badge key={tag} variant="outline" className="text-xs py-0.5">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {/* FIX-MARKET-UI / FIX 2 — View Answers link. */}
                  <div className="pt-1">
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-primary gap-1.5"
                      onClick={() => setOpenQuestion(q)}
                    >
                      <MessageSquare className="size-3.5" />
                      {t("marketplace-community-view-answers")}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}

      {/* FIX-MARKET-UI / FIX 2 — Answers modal. */}
      <QuestionAnswersDialog
        question={openQuestion}
        onClose={() => setOpenQuestion(null)}
      />
    </div>
  );
}

// ─── QuestionAnswersDialog ────────────────────────────────────────────────
//
// Modal that shows the answers for a question + a composer to post a new
// answer. The dialog is uncontrolled on the question prop — when null,
// it stays closed.
function QuestionAnswersDialog({
  question,
  onClose,
}: {
  question: Question | null;
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");

  const answersQ = useQuery<AnswersResponse>({
    queryKey: ["community-question-answers", question?.id],
    queryFn: async () => {
      const r = await fetch(`/api/marketplace/questions/${question!.id}/answers`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    enabled: !!question,
  });
  const answers = answersQ.data?.items ?? [];

  const postMut = useMutation({
    mutationFn: async () => {
      if (!question) return;
      const body = draft.trim();
      if (body.length < 1) throw new Error(t("marketplace-detail-qa-answer-failed"));
      const r = await fetch(`/api/marketplace/questions/${question.id}/answers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e?.error || t("marketplace-detail-qa-answer-failed"));
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("marketplace-detail-qa-answer-submitted"));
      setDraft("");
      if (question) {
        qc.invalidateQueries({ queryKey: ["community-question-answers", question.id] });
        qc.invalidateQueries({ queryKey: ["community-questions"] });
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={!!question} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="size-5 text-primary" />
            {t("marketplace-community-question-detail-title")}
          </DialogTitle>
          {question && (
            <DialogDescription className="text-sm font-medium text-foreground">
              {question.title}
            </DialogDescription>
          )}
        </DialogHeader>

        {question?.body && (
          <div className="rounded-md border border-border/40 bg-muted/20 p-3">
            <p className="text-sm whitespace-pre-wrap">{question.body}</p>
          </div>
        )}

        {/* Answers list */}
        <div className="space-y-2 max-h-[40vh] overflow-y-auto custom-scroll">
          {answersQ.isLoading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : answers.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              {t("marketplace-detail-qa-no-answers")}
            </p>
          ) : (
            answers.map((a) => (
              <div
                key={a.id}
                className="rounded-md border border-border/40 bg-card p-3 space-y-1"
              >
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{a.body}</p>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{a.partner_id.slice(0, 8)}…</span>
                  <span>·</span>
                  <span>{new Date(a.created_at).toLocaleDateString()}</span>
                  {a.is_accepted && (
                    <Badge variant="outline" className="border-emerald-500/40 text-emerald-700 dark:text-emerald-400 gap-1">
                      <CheckCircle2 className="size-3" />
                      Accepted
                    </Badge>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Composer */}
        <div className="space-y-2 border-t border-border/40 pt-3">
          <Label htmlFor="ans-draft" className="text-xs">
            {t("marketplace-detail-qa-answer-label")}
          </Label>
          <Textarea
            id="ans-draft"
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t("marketplace-detail-qa-answer-placeholder")}
          />
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("portal-action-cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => postMut.mutate()}
            disabled={postMut.isPending || draft.trim().length < 1}
            className="gap-1.5"
          >
            {postMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            {t("marketplace-detail-qa-answer-submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
