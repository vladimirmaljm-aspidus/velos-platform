"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2, Plus, Search, Calendar, MapPin, Video, Users, XCircle } from "lucide-react";
import { toast } from "sonner";
import { useT } from "@/lib/i18n/store";
import type {
  CommunityEvent,
  EventType,
} from "@/lib/supabase/marketplace-community-types";
import { EVENT_TYPE_LABEL_KEY } from "@/lib/supabase/marketplace-community-types";

interface ListResponse {
  items: CommunityEvent[];
  total: number;
}

const EVENT_TYPES: EventType[] = [
  "conference", "webinar", "trade_show", "auction", "meeting", "workshop",
];

/**
 * Event calendar (list view, not month-grid — v1 surface). Each card
 * shows the event title, a type badge, date/time, location (or "Online"
 * with meeting URL), attendee count, and a Register/Registered button.
 *
 * The register button calls POST /api/marketplace/events/[id]/register
 * and toggles to a "Registered" state on success. The unregister (DELETE)
 * path is exposed via the secondary "Cancel" affordance.
 */
export function EventCalendar({ onCreateClick }: { onCreateClick?: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [type, setType] = useState<string>("all");

  const qp = new URLSearchParams({ limit: "24", upcoming: "1" });
  if (search.trim()) qp.set("search", search.trim());
  if (type !== "all") qp.set("event_type", type);

  const q = useQuery<ListResponse>({
    queryKey: ["community-events", search, type],
    queryFn: async () => {
      const r = await fetch(`/api/marketplace/events?${qp}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });

  const registerMut = useMutation({
    mutationFn: async (eventId: string) => {
      const r = await fetch(`/api/marketplace/events/${eventId}/register`, { method: "POST" });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: "Failed." }));
        throw new Error(err?.error || "Failed.");
      }
      return r.json();
    },
    onSuccess: (data) => {
      toast.success(data?.registered ? t("marketplace-community-registered") : t("marketplace-community-already-registered"));
      qc.invalidateQueries({ queryKey: ["community-events", search, type] });
    },
    onError: (e: any) => toast.error(e?.message || t("marketplace-community-register-failed")),
  });

  const unregisterMut = useMutation({
    mutationFn: async (eventId: string) => {
      const r = await fetch(`/api/marketplace/events/${eventId}/register`, { method: "DELETE" });
      if (!r.ok) throw new Error("Failed.");
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("marketplace-community-unregistered"));
      qc.invalidateQueries({ queryKey: ["community-events", search, type] });
    },
    onError: () => toast.error(t("marketplace-community-unregister-failed")),
  });

  const items = q.data?.items ?? [];
  const total = q.data?.total ?? 0;

  function fmtDate(start: string, end: string): string {
    const s = new Date(start);
    const e = new Date(end);
    const sameDay = s.toDateString() === e.toDateString();
    const opts: Intl.DateTimeFormatOptions = {
      month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit",
    };
    if (sameDay) {
      return `${s.toLocaleString(undefined, opts)} – ${e.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
    }
    return `${s.toLocaleString(undefined, opts)} – ${e.toLocaleString(undefined, opts)}`;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("marketplace-community-events-search-placeholder")}
            className="pl-9"
          />
        </div>
        <Select value={type} onValueChange={setType}>
          <SelectTrigger className="sm:w-44">
            <SelectValue placeholder={t("marketplace-community-event-type")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("marketplace-community-event-type-all")}</SelectItem>
            {EVENT_TYPES.map((et) => (
              <SelectItem key={et} value={et}>
                {t(EVENT_TYPE_LABEL_KEY[et])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {onCreateClick && (
          <Button onClick={onCreateClick} className="gap-1.5">
            <Plus className="h-4 w-4" />
            {t("marketplace-community-create-event")}
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
          {t("marketplace-community-events-empty")}
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {t("marketplace-community-results-count").replace("{n}", String(total))}
          </p>
          <div className="space-y-3">
            {items.map((ev) => (
              <Card key={ev.id}>
                <CardContent className="p-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-1.5 min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      {ev.event_type && (
                        <Badge variant="secondary" className="capitalize">
                          {t(EVENT_TYPE_LABEL_KEY[ev.event_type as EventType])}
                        </Badge>
                      )}
                      <h3 className="font-medium text-sm truncate">{ev.title}</h3>
                    </div>
                    <p className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
                      <Calendar className="h-3.5 w-3.5" />
                      {fmtDate(ev.start_date, ev.end_date)}
                    </p>
                    {ev.location && (
                      <p className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
                        <MapPin className="h-3.5 w-3.5" />
                        {ev.location}
                      </p>
                    )}
                    {ev.is_online && ev.meeting_url && (
                      <a
                        href={ev.meeting_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-primary inline-flex items-center gap-1.5 hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Video className="h-3.5 w-3.5" />
                        {t("marketplace-community-join-online")}
                      </a>
                    )}
                    {ev.description && (
                      <p className="text-sm text-muted-foreground line-clamp-2 pt-1">{ev.description}</p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-2 shrink-0">
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Users className="h-3.5 w-3.5" />
                      {t("marketplace-community-attendees-count").replace("{n}", String(ev.attendees_count))}
                    </span>
                    <Button
                      size="sm"
                      onClick={() => registerMut.mutate(ev.id)}
                      disabled={registerMut.isPending || unregisterMut.isPending}
                    >
                      {t("marketplace-community-register")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-muted-foreground"
                      onClick={() => unregisterMut.mutate(ev.id)}
                      disabled={registerMut.isPending || unregisterMut.isPending}
                    >
                      <XCircle className="h-3.5 w-3.5 mr-1" />
                      {t("marketplace-community-cancel")}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
