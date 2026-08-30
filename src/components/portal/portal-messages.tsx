"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Send, Loader2, MessageSquare, CheckCheck, Check, Paperclip } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtDateTime, fmtRelative, initials } from "@/lib/utils/format";
import { useAppStore } from "@/lib/store/app-store";
import { toast } from "sonner";
import type { PortalAccess, Partner } from "@/lib/supabase/types";
import { useT } from "@/lib/i18n/store";
import { MAX_UPLOAD_SIZE } from "@/lib/upload/constants";

interface PortalMessage {
  id: string;
  direction: "portal_to_admin" | "admin_to_portal";
  body: string;
  sender_username: string;
  read_at: string | null;
  created_at: string;
  attachment_url: string | null;
  attachment_name: string | null;
}

/** Groups messages by yyyy-mm-dd for date separators. */
function groupByDay(items: PortalMessage[]) {
  const groups = new Map<string, PortalMessage[]>();
  for (const m of items) {
    const day = new Date(m.created_at).toISOString().slice(0, 10);
    (groups.get(day) ?? groups.set(day, []).get(day)!).push(m);
  }
  return [...groups.entries()].map(([day, msgs]) => ({ day, msgs }));
}

function dayLabel(iso: string, t: (key: string) => string): string {
  const d = new Date(iso);
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  if (iso === today) return t("portal-messages-today");
  if (iso === yesterday) return t("portal-messages-yesterday");
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

export function PortalMessages() {
  const t = useT();
  const qc = useQueryClient();
  const [input, setInput] = useState("");
  const access = useAppStore((s) => s.portalAccess) as PortalAccess | null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [partnerName, setPartnerName] = useState("Client");

  // Load partner name once for avatar
  useEffect(() => {
    fetch("/api/portal/profile")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { partner?: Partner } | null) => { if (d?.partner?.name) setPartnerName(d.partner.name); })
      .catch(() => {});
  }, []);

  const messagesQ = useQuery<{ items: PortalMessage[] }>({
    queryKey: ["portal-messages"],
    queryFn: async () => {
      const r = await fetch("/api/portal/messages");
      if (!r.ok) throw new Error("Failed to load messages");
      return r.json();
    },
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });

  const items = messagesQ.data?.items || [];
  const grouped = useMemo(() => groupByDay(items), [items]);

  useEffect(() => {
    // Auto-scroll to bottom on new messages
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [items.length]);

  // PORTAL-M7 — Explicit "mark thread read" on mount only (NOT on every 15s
  // poll). The GET handler no longer auto-marks read; the user must
  // deliberately open the thread (mount) for messages to be marked read.
  useEffect(() => {
    fetch("/api/portal/messages/read", { method: "POST" }).catch(() => {});
  }, []);

  const [attachment, setAttachment] = useState<{ id: string; filename: string; mime_type: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const sendMut = useMutation({
    mutationFn: async (body: string) => {
      const payload: any = { body };
      if (attachment) {
        // 2b2-F1 — point at the new portal-side download route
        // `/api/portal/attachments/<id>` (handled by
        // `src/app/api/portal/attachments/[id]/route.ts`, which uses
        // `getPortalSessionAccess` — NOT admin `requireAuth`). The
        // previous code used `/api/portal/upload/<id>/download?mode=inline`
        // (singular `/upload/`) which had no route handler at all, so
        // the link silently 404'd for the recipient. The messages POST
        // route's `ATTACHMENT_URL_RE_SINGULAR` regex now accepts this
        // exact URL form.
        payload.attachment_url = `/api/portal/attachments/${attachment.id}?mode=inline`;
        payload.attachment_name = attachment.filename;
        payload.attachment_type = attachment.mime_type;
      }
      const r = await fetch("/api/portal/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || t("portal-messages-toast-send-failed"));
      }
      return r.json();
    },
    onSuccess: () => {
      setInput("");
      setAttachment(null);
      qc.invalidateQueries({ queryKey: ["portal-messages"] });
    },
    onError: (e: Error) => toast.error(e.message || t("portal-messages-toast-send-failed")),
  });

  const canSend = (input.trim().length > 0 || !!attachment) && !sendMut.isPending && !uploading;

  function submit() {
    if (canSend) sendMut.mutate(input.trim());
  }

  async function handleAttach(file: File) {
    if (file.size > MAX_UPLOAD_SIZE) {
      toast.error(t("portal-messages-toast-file-too-large"));
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("category", "message");
      const r = await fetch("/api/portal/upload", { method: "POST", body: fd });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || t("portal-messages-toast-upload-failed"));
      }
      const row = await r.json();
      setAttachment({ id: row.id, filename: row.filename, mime_type: row.mime_type });
    } catch (e: any) {
      toast.error(e.message || t("portal-messages-toast-upload-failed"));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="max-w-3xl mx-auto h-[calc(100vh-180px)] flex flex-col">
      {/* Header */}
      <div className="rounded-t-2xl border border-b-0 border-border/60 bg-card px-5 py-3 flex items-center gap-3 shadow-soft">
        <div className="size-10 rounded-full bg-gradient-emerald flex items-center justify-center text-white">
          <MessageSquare className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{t("portal-messages-support")}</p>
          <p className="text-xs text-muted-foreground">
            {messagesQ.isFetching ? t("portal-messages-refreshing") : t("portal-messages-replies")}
          </p>
        </div>
      </div>

      {/* Thread */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto custom-scroll border-x border-border/60 bg-muted/20 px-4 py-6 space-y-4"
      >
        {messagesQ.isLoading ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin mr-2" /> {t("portal-messages-loading")}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center text-sm text-muted-foreground">
            <div className="size-14 rounded-full bg-primary/10 flex items-center justify-center mb-3">
              <MessageSquare className="size-6 text-primary" />
            </div>
            <p className="text-base font-medium text-foreground">{t("portal-messages-start")}</p>
            <p className="max-w-xs mt-1">{t("portal-messages-start-desc")}</p>
          </div>
        ) : (
          grouped.map(({ day, msgs }) => (
            <div key={day} className="space-y-3">
              <div className="flex items-center gap-2 my-2">
                <div className="flex-1 h-px bg-border" />
                <span className="text-xs uppercase tracking-wider text-muted-foreground">{dayLabel(day, t)}</span>
                <div className="flex-1 h-px bg-border" />
              </div>
              {msgs.map((m) => <Bubble key={m.id} m={m} partnerName={partnerName} />)}
            </div>
          ))
        )}
      </div>

      {/* Composer */}
      <div className="rounded-b-2xl border border-t-0 border-border/60 bg-card p-3 shadow-soft">
        {attachment && (
          <div className="mb-2 flex items-center gap-2 rounded-md border bg-muted/30 px-2 py-1 text-xs">
            <Paperclip className="size-3.5 text-primary" />
            <span className="truncate flex-1">{attachment.filename}</span>
            <button type="button" className="text-muted-foreground hover:text-destructive" onClick={() => setAttachment(null)}>×</button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            className="sr-only"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleAttach(f); }}
            accept="application/pdf,image/*,.doc,.docx,.xls,.xlsx,text/plain,text/csv"
          />
          <Button
            type="button"
            size="lg"
            variant="ghost"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || sendMut.isPending || !!attachment}
            className="h-[52px] px-3"
            title={t("portal-messages-attach-file")}
            aria-label={t("portal-messages-aria-attach")}
          >
            {uploading ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
          </Button>
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder={t("portal-messages-placeholder")}
            rows={2}
            maxLength={8000}
            className="resize-none flex-1 min-h-[52px]"
            disabled={sendMut.isPending}
          />
          <Button
            size="lg"
            onClick={submit}
            disabled={!canSend}
            className="h-[52px] px-4"
            aria-label={t("portal-messages-send")}
          >
            {sendMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-2 px-1">
          {t("portal-messages-privacy")}
        </p>
      </div>
    </div>
  );
}

function Bubble({ m, partnerName }: { m: PortalMessage; partnerName: string }) {
  const isMine = m.direction === "portal_to_admin";
  return (
    <div className={cn("flex items-end gap-2", isMine ? "justify-end" : "justify-start")}>
      {!isMine && (
        <Avatar className="size-7 shrink-0">
          <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">AS</AvatarFallback>
        </Avatar>
      )}
      <div
        className={cn(
          "max-w-[75%] rounded-2xl px-4 py-2.5 shadow-soft break-words",
          isMine
            ? "bg-primary text-primary-foreground rounded-br-md"
            : "bg-card border border-border/60 rounded-bl-md",
        )}
      >
        <p className="text-sm whitespace-pre-wrap leading-relaxed">{m.body}</p>
        {m.attachment_url && m.attachment_name && (
          <a
            href={m.attachment_url}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "mt-2 inline-flex items-center gap-1.5 text-xs font-medium underline",
              isMine ? "text-primary-foreground/90" : "text-primary",
            )}
          >
            <Paperclip className="size-3" />
            {m.attachment_name}
          </a>
        )}
        <div className={cn("flex items-center gap-1 mt-1 text-xs tabular", isMine ? "text-primary-foreground/70 justify-end" : "text-muted-foreground")}>
          <span title={fmtDateTime(m.created_at)}>{new Date(m.created_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
          {isMine && (m.read_at ? <CheckCheck className="size-3" /> : <Check className="size-3" />)}
        </div>
      </div>
      {isMine && (
        <Avatar className="size-7 shrink-0">
          <AvatarFallback className="bg-muted text-muted-foreground text-xs font-semibold">
            {initials(partnerName)}
          </AvatarFallback>
        </Avatar>
      )}
    </div>
  );
}
