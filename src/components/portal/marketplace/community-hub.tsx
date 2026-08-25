"use client";

import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Users,
  MessageSquare,
  Calendar,
  Newspaper,
  Loader2,
  Send,
  CheckCircle2,
  Plus,
} from "lucide-react";
import { toast } from "sonner";
import { useT } from "@/lib/i18n/store";
import { GroupList } from "./group-list";
import { QuestionList } from "./question-list";
import { EventCalendar } from "./event-calendar";
import { BlogFeed } from "./blog-feed";
import type {
  EventType,
} from "@/lib/supabase/marketplace-community-types";
import { EVENT_TYPE_LABEL_KEY } from "@/lib/supabase/marketplace-community-types";

/**
 * Community hub — top-level surface for Marketplace Phase 10.
 *
 * The hub uses Tabs to switch between the four community surfaces
 * (Groups / Q&A / Events / Blog). Each tab renders its own data-
 * fetching child component; the hub stays mostly stateless except for
 * the active-tab state.
 *
 * FIX-MARKET-UI / FIX 2 — wired the "Create" affordances that were
 * previously no-op stubs. The four create dialogs (Create Group,
 * Ask Question, Create Event, Write Blog Post) live in this file so
 * the children stay presentational + data-fetching only.
 */
export function CommunityHub() {
  const t = useT();
  const [tab, setTab] = useState("groups");

  // Create-dialog open state for each entity type.
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showAskQuestion, setShowAskQuestion] = useState(false);
  const [showCreateEvent, setShowCreateEvent] = useState(false);
  const [showWriteBlog, setShowWriteBlog] = useState(false);

  return (
    <div className="space-y-4 max-w-6xl mx-auto">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("marketplace-community-title")}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {t("marketplace-community-subtitle")}
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v)}>
        <TabsList>
          <TabsTrigger value="groups" className="gap-1.5">
            <Users className="h-4 w-4" />
            {t("marketplace-community-tab-groups")}
          </TabsTrigger>
          <TabsTrigger value="qa" className="gap-1.5">
            <MessageSquare className="h-4 w-4" />
            {t("marketplace-community-tab-qa")}
          </TabsTrigger>
          <TabsTrigger value="events" className="gap-1.5">
            <Calendar className="h-4 w-4" />
            {t("marketplace-community-tab-events")}
          </TabsTrigger>
          <TabsTrigger value="blog" className="gap-1.5">
            <Newspaper className="h-4 w-4" />
            {t("marketplace-community-tab-blog")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="groups" className="mt-4">
          <GroupList onCreateClick={() => setShowCreateGroup(true)} />
        </TabsContent>
        <TabsContent value="qa" className="mt-4">
          <QuestionList onCreateClick={() => setShowAskQuestion(true)} />
        </TabsContent>
        <TabsContent value="events" className="mt-4">
          <EventCalendar onCreateClick={() => setShowCreateEvent(true)} />
        </TabsContent>
        <TabsContent value="blog" className="mt-4">
          <BlogFeed onCreateClick={() => setShowWriteBlog(true)} />
        </TabsContent>
      </Tabs>

      {/* Create flows (FIX-MARKET-UI / FIX 2) */}
      <CreateGroupDialog open={showCreateGroup} onOpenChange={setShowCreateGroup} />
      <AskQuestionDialog open={showAskQuestion} onOpenChange={setShowAskQuestion} />
      <CreateEventDialog open={showCreateEvent} onOpenChange={setShowCreateEvent} />
      <WriteBlogDialog open={showWriteBlog} onOpenChange={setShowWriteBlog} />
    </div>
  );
}

// ─── Slug helper ───────────────────────────────────────────────────────────
// Matches `slugify` in marketplace-community-store (lowercase, hyphenated,
// strips non [a-z0-9] chars). Used to auto-derive the slug for groups and
// blog posts when the user leaves the field blank.
function autoSlug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// ─── Create Group dialog ───────────────────────────────────────────────────
function CreateGroupDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);

  // Reset on close so re-opening doesn't show stale form.
  useMemo(() => {
    if (!open) {
// eslint-disable-next-line react-hooks/set-state-in-render
      setName("");
// eslint-disable-next-line react-hooks/set-state-in-render
      setDescription("");
// eslint-disable-next-line react-hooks/set-state-in-render
      setCategory("");
// eslint-disable-next-line react-hooks/set-state-in-render
      setIsPrivate(false);
    }
  }, [open]);

  const mut = useMutation({
    mutationFn: async () => {
      if (name.trim().length < 2) throw new Error(t("marketplace-community-create-group-failed"));
      const r = await fetch("/api/marketplace/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          category: category.trim() || undefined,
          is_private: isPrivate,
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e?.error || t("marketplace-community-create-group-failed"));
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("marketplace-community-create-group-saved"));
      onOpenChange(false);
      qc.invalidateQueries({ queryKey: ["community-groups"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="size-5 text-primary" />
            {t("marketplace-community-create-group-dialog-title")}
          </DialogTitle>
          <DialogDescription>
            {t("marketplace-community-create-group-dialog-desc")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="grp-name">{t("marketplace-community-create-group-name-label")}</Label>
            <Input
              id="grp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("marketplace-community-create-group-name-placeholder")}
            />
          </div>
          <div>
            <Label htmlFor="grp-desc">{t("marketplace-community-create-group-description-label")}</Label>
            <Textarea
              id="grp-desc"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("marketplace-community-create-group-description-placeholder")}
            />
          </div>
          <div>
            <Label htmlFor="grp-cat">{t("marketplace-community-create-group-category-label")}</Label>
            <Input
              id="grp-cat"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder={t("marketplace-community-create-group-category-placeholder")}
            />
          </div>
          <div className="flex items-center gap-3 p-3 rounded-md bg-muted/30">
            <Switch
              id="grp-private"
              checked={isPrivate}
              onCheckedChange={setIsPrivate}
              aria-label={t("marketplace-community-create-group-private-label")}
            />
            <Label htmlFor="grp-private" className="text-sm">
              {t("marketplace-community-create-group-private-label")}
            </Label>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("portal-action-cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => mut.mutate()}
            disabled={mut.isPending || name.trim().length < 2}
            className="gap-1.5"
          >
            {mut.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            {t("marketplace-community-create-group-submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Ask Question dialog ───────────────────────────────────────────────────
function AskQuestionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [groupId, setGroupId] = useState<string>("");

  useMemo(() => {
    if (!open) {
// eslint-disable-next-line react-hooks/set-state-in-render
      setTitle("");
// eslint-disable-next-line react-hooks/set-state-in-render
      setBody("");
// eslint-disable-next-line react-hooks/set-state-in-render
      setGroupId("");
    }
  }, [open]);

  // Fetch the user's joined groups so the question can be posted into one.
  const groupsQ = useQuery<{ items: { id: string; name: string }[]; total: number }>({
    queryKey: ["community-groups", "joined"],
    queryFn: async () => {
      const r = await fetch("/api/marketplace/groups?joined=1&limit=100");
      if (!r.ok) return { items: [], total: 0 };
      return r.json();
    },
    enabled: open,
  });
  const groups = groupsQ.data?.items ?? [];

  const mut = useMutation({
    mutationFn: async () => {
      if (title.trim().length < 3) throw new Error(t("marketplace-community-ask-question-failed"));
      const payload: Record<string, unknown> = {
        title: title.trim(),
        body: body.trim() || undefined,
      };
      if (groupId) payload.group_id = groupId;
      const r = await fetch("/api/marketplace/questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e?.error || t("marketplace-community-ask-question-failed"));
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("marketplace-community-ask-question-saved"));
      onOpenChange(false);
      qc.invalidateQueries({ queryKey: ["community-questions"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="size-5 text-primary" />
            {t("marketplace-community-ask-question-dialog-title")}
          </DialogTitle>
          <DialogDescription>
            {t("marketplace-community-ask-question-dialog-desc")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="q-group">{t("marketplace-community-ask-question-group-label")}</Label>
            <Select value={groupId} onValueChange={setGroupId}>
              <SelectTrigger id="q-group">
                <SelectValue placeholder={t("marketplace-community-ask-question-group-none")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">{t("marketplace-community-ask-question-group-none")}</SelectItem>
                {groups.map((g) => (
                  <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="q-title">{t("marketplace-community-ask-question-title-label")}</Label>
            <Input
              id="q-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("marketplace-community-ask-question-title-placeholder")}
            />
          </div>
          <div>
            <Label htmlFor="q-body">{t("marketplace-community-ask-question-body-label")}</Label>
            <Textarea
              id="q-body"
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t("marketplace-community-ask-question-body-placeholder")}
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("portal-action-cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => mut.mutate()}
            disabled={mut.isPending || title.trim().length < 3}
            className="gap-1.5"
          >
            {mut.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            {t("marketplace-community-ask-question-submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Create Event dialog ───────────────────────────────────────────────────
const EVENT_TYPES: EventType[] = [
  "conference", "webinar", "trade_show", "auction", "meeting", "workshop",
];

function CreateEventDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [eventType, setEventType] = useState<string>("conference");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [location, setLocation] = useState("");

  useMemo(() => {
    if (!open) {
// eslint-disable-next-line react-hooks/set-state-in-render
      setTitle("");
// eslint-disable-next-line react-hooks/set-state-in-render
      setDescription("");
// eslint-disable-next-line react-hooks/set-state-in-render
      setEventType("conference");
// eslint-disable-next-line react-hooks/set-state-in-render
      setStartDate("");
// eslint-disable-next-line react-hooks/set-state-in-render
      setEndDate("");
// eslint-disable-next-line react-hooks/set-state-in-render
      setLocation("");
    }
  }, [open]);

  const mut = useMutation({
    mutationFn: async () => {
      if (title.trim().length < 3) throw new Error(t("marketplace-community-create-event-failed"));
      if (!startDate) throw new Error(t("marketplace-community-create-event-start-required"));
      if (!endDate) throw new Error(t("marketplace-community-create-event-end-required"));
      const s = new Date(startDate);
      const e = new Date(endDate);
      if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
        throw new Error(t("marketplace-community-create-event-failed"));
      }
      if (e.getTime() < s.getTime()) {
        throw new Error(t("marketplace-community-create-event-end-after-start"));
      }
      const r = await fetch("/api/marketplace/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          event_type: eventType,
          start_date: s.toISOString(),
          end_date: e.toISOString(),
          location: location.trim() || undefined,
          // Capacity is part of the spec but the events table doesn't have a
          // capacity column yet — silently dropped on submit. Adding it
          // would require a migration; out of scope for this UI fix.
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e?.error || t("marketplace-community-create-event-failed"));
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("marketplace-community-create-event-saved"));
      onOpenChange(false);
      qc.invalidateQueries({ queryKey: ["community-events"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // The datetime-local input returns "YYYY-MM-DDTHH:mm" (local time). The
  // mutation converts to ISO 8601 before sending.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Calendar className="size-5 text-primary" />
            {t("marketplace-community-create-event-dialog-title")}
          </DialogTitle>
          <DialogDescription>
            {t("marketplace-community-create-event-dialog-desc")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="ev-title">{t("marketplace-community-create-event-title-label")}</Label>
            <Input
              id="ev-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("marketplace-community-create-event-title-placeholder")}
            />
          </div>
          <div>
            <Label htmlFor="ev-desc">{t("marketplace-community-create-event-description-label")}</Label>
            <Textarea
              id="ev-desc"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("marketplace-community-create-event-description-placeholder")}
            />
          </div>
          <div>
            <Label htmlFor="ev-type">{t("marketplace-community-create-event-type-label")}</Label>
            <Select value={eventType} onValueChange={setEventType}>
              <SelectTrigger id="ev-type"><SelectValue /></SelectTrigger>
              <SelectContent>
                {EVENT_TYPES.map((et) => (
                  <SelectItem key={et} value={et}>
                    {t(EVENT_TYPE_LABEL_KEY[et])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ev-start">{t("marketplace-community-create-event-start-label")}</Label>
              <Input
                id="ev-start"
                type="datetime-local"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="ev-end">{t("marketplace-community-create-event-end-label")}</Label>
              <Input
                id="ev-end"
                type="datetime-local"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="ev-loc">{t("marketplace-community-create-event-location-label")}</Label>
            <Input
              id="ev-loc"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder={t("marketplace-community-create-event-location-placeholder")}
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("portal-action-cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => mut.mutate()}
            disabled={mut.isPending || title.trim().length < 3}
            className="gap-1.5"
          >
            {mut.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            {t("marketplace-community-create-event-submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Write Blog Post dialog ────────────────────────────────────────────────
function WriteBlogDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [body, setBody] = useState("");
  const [tagsInput, setTagsInput] = useState("");

  useMemo(() => {
    if (!open) {
// eslint-disable-next-line react-hooks/set-state-in-render
      setTitle("");
// eslint-disable-next-line react-hooks/set-state-in-render
      setSlug("");
// eslint-disable-next-line react-hooks/set-state-in-render
      setBody("");
// eslint-disable-next-line react-hooks/set-state-in-render
      setTagsInput("");
    }
  }, [open]);

  const mut = useMutation({
    mutationFn: async () => {
      if (title.trim().length < 3) throw new Error(t("marketplace-community-write-blog-failed"));
      if (body.trim().length < 1) throw new Error(t("marketplace-community-write-blog-failed"));
      const finalSlug = slug.trim() || autoSlug(title);
      if (!/^[a-z0-9-]{2,80}$/.test(finalSlug)) {
        throw new Error(t("marketplace-community-write-blog-failed"));
      }
      const tags = tagsInput
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length >= 1 && s.length <= 40)
        .slice(0, 20);
      const r = await fetch("/api/marketplace/blog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          slug: finalSlug,
          body: body.trim(),
          tags,
          status: "published",
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e?.error || t("marketplace-community-write-blog-failed"));
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("marketplace-community-write-blog-saved"));
      onOpenChange(false);
      qc.invalidateQueries({ queryKey: ["community-blog"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Newspaper className="size-5 text-primary" />
            {t("marketplace-community-write-blog-dialog-title")}
          </DialogTitle>
          <DialogDescription>
            {t("marketplace-community-write-blog-dialog-desc")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="bl-title">{t("marketplace-community-write-blog-title-label")}</Label>
            <Input
              id="bl-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("marketplace-community-write-blog-title-placeholder")}
            />
          </div>
          <div>
            <Label htmlFor="bl-slug">{t("marketplace-community-write-blog-slug-label")}</Label>
            <Input
              id="bl-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder={t("marketplace-community-write-blog-slug-placeholder")}
            />
            <p className="text-xs text-muted-foreground mt-1">
              {t("marketplace-community-write-blog-slug-hint")}
            </p>
          </div>
          <div>
            <Label htmlFor="bl-body">{t("marketplace-community-write-blog-body-label")}</Label>
            <Textarea
              id="bl-body"
              rows={8}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t("marketplace-community-write-blog-body-placeholder")}
            />
          </div>
          <div>
            <Label htmlFor="bl-tags">{t("marketplace-community-write-blog-tags-label")}</Label>
            <Input
              id="bl-tags"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder={t("marketplace-community-write-blog-tags-placeholder")}
            />
            {tagsInput && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {tagsInput.split(",").map((s, i) => {
                  const tag = s.trim();
                  if (!tag) return null;
                  return (
                    <Badge key={i} variant="outline" className="text-xs">
                      {tag}
                    </Badge>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("portal-action-cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => mut.mutate()}
            disabled={mut.isPending || title.trim().length < 3 || body.trim().length < 1}
            className="gap-1.5"
          >
            {mut.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            {t("marketplace-community-write-blog-submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
