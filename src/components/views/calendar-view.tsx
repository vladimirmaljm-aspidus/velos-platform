"use client";

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChevronLeft, ChevronRight, Calendar as CalendarIcon,
  CheckCircle2, FileText, Handshake, Receipt, ListChecks,
} from "lucide-react";
import { PageHeader } from "@/components/common/page-header";
import { ModuleInfoTooltip } from "@/components/common/module-info-tooltip";

import { cn } from "@/lib/utils";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { fmtNumber, fmtMoney } from "@/lib/utils/format";
import { useT } from "@/lib/i18n/store";

interface CalendarEvent {
  id: string;
  type: "task" | "invoice" | "deal" | "offer";
  title: string;
  date: string;
  status?: string;
  amount?: number;
  currency?: string;
  entity_id: string;
  color: string;
}

const TYPE_ICON = {
  task: ListChecks,
  invoice: Receipt,
  deal: Handshake,
  offer: FileText,
};

const TYPE_LABEL = {
  task: "Task",
  invoice: "Invoice",
  deal: "Deal",
  offer: "Offer",
};

export function CalendarView() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [currentDate, setCurrentDate] = useState(new Date());

  // Calculate month range
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const from = firstDay.toISOString().split("T")[0];
  const to = lastDay.toISOString().split("T")[0];

  const { data, isLoading } = useQuery<{ items: CalendarEvent[] }>({
    queryKey: ["calendar", tenantKey, from, to],
    queryFn: async () => {
      const r = await fetch(api(`/api/calendar?from=${from}&to=${to}`));
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  const events = data?.items || [];

  // Build calendar grid
  const days = useMemo(() => {
    const startOfWeek = new Date(firstDay);
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay()); // Sunday = 0
    const endOfWeek = new Date(lastDay);
    endOfWeek.setDate(endOfWeek.getDate() + (6 - endOfWeek.getDay()));

    const daysArr: Date[] = [];
    const d = new Date(startOfWeek);
    while (d <= endOfWeek) {
      daysArr.push(new Date(d));
      d.setDate(d.getDate() + 1);
    }
    return daysArr;
  }, [firstDay, lastDay]);

  // Group events by date
  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of events) {
      const dateKey = e.date.split("T")[0];
      if (!map.has(dateKey)) map.set(dateKey, []);
      map.get(dateKey)!.push(e);
    }
    return map;
  }, [events]);

  function prevMonth() {
    setCurrentDate(new Date(year, month - 1, 1));
  }
  function nextMonth() {
    setCurrentDate(new Date(year, month + 1, 1));
  }
  function goToday() {
    setCurrentDate(new Date());
  }

  const today = new Date().toISOString().split("T")[0];
  const monthName = currentDate.toLocaleString("en-US", { month: "long", year: "numeric" });

  // Stats
  const stats = useMemo(() => {
    const byType = { task: 0, invoice: 0, deal: 0, offer: 0 };
    for (const e of events) byType[e.type]++;
    return byType;
  }, [events]);

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("calendar")}
        description={t("misc-calendar-desc")}
      />
      <ModuleInfoTooltip
        title="Calendar"
        description="View and manage your trade events — deal deadlines, invoice due dates, meetings, and reminders."
        howToUse={["View events by month/week/day", "Click a date to add an event", "Color-coded by event type", "Syncs with deals and invoices"]}
      />

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="border-border/60 shadow-soft">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="size-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
              <ListChecks className="size-5 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold tabular">{fmtNumber(stats.task)}</p>
              <p className="text-xs text-muted-foreground">{t("misc-tasks-due")}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-border/60 shadow-soft">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="size-10 rounded-lg bg-amber-500/10 flex items-center justify-center">
              <Receipt className="size-5 text-amber-600" />
            </div>
            <div>
              <p className="text-2xl font-bold tabular">{fmtNumber(stats.invoice)}</p>
              <p className="text-xs text-muted-foreground">{t("misc-invoices-due")}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-border/60 shadow-soft">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="size-10 rounded-lg bg-violet-500/10 flex items-center justify-center">
              <Handshake className="size-5 text-violet-600" />
            </div>
            <div>
              <p className="text-2xl font-bold tabular">{fmtNumber(stats.deal)}</p>
              <p className="text-xs text-muted-foreground">{t("misc-deal-closes")}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-border/60 shadow-soft">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="size-10 rounded-lg bg-cyan-500/10 flex items-center justify-center">
              <FileText className="size-5 text-cyan-600" />
            </div>
            <div>
              <p className="text-2xl font-bold tabular">{fmtNumber(stats.offer)}</p>
              <p className="text-xs text-muted-foreground">{t("misc-offers-expire")}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="border-border/60 shadow-soft">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2">
            <CalendarIcon className="size-5" />
            {monthName}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={prevMonth}>
              <ChevronLeft className="size-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={goToday}>
              {t("misc-today")}
            </Button>
            <Button variant="outline" size="sm" onClick={nextMonth}>
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="grid grid-cols-7 gap-2">
              {Array.from({ length: 35 }).map((_, i) => (
                <Skeleton key={i} className="h-28 rounded-lg" />
              ))}
            </div>
          ) : (
            <>
              {/* Day headers */}
              <div className="grid grid-cols-7 gap-2 mb-2">
                {["misc-day-sun", "misc-day-mon", "misc-day-tue", "misc-day-wed", "misc-day-thu", "misc-day-fri", "misc-day-sat"].map((k) => (
                  <div key={k} className="text-center text-xs font-semibold text-muted-foreground py-2">
                    {t(k)}
                  </div>
                ))}
              </div>
              {/* Calendar grid */}
              <div className="grid grid-cols-7 gap-2">
                {days.map((day) => {
                  const dateKey = day.toISOString().split("T")[0];
                  const dayEvents = eventsByDate.get(dateKey) || [];
                  const isToday = dateKey === today;
                  const isCurrentMonth = day.getMonth() === month;
                  return (
                    <div
                      key={dateKey}
                      className={cn(
                        "min-h-28 rounded-lg border p-1.5 transition-colors",
                        isCurrentMonth ? "border-border/60 bg-card" : "border-border/30 bg-muted/30",
                        isToday && "ring-2 ring-primary ring-offset-1"
                      )}
                    >
                      <div className={cn(
                        "text-xs font-medium mb-1",
                        isToday ? "text-primary" : isCurrentMonth ? "text-foreground" : "text-muted-foreground/50"
                      )}>
                        {day.getDate()}
                      </div>
                      <div className="space-y-1">
                        {dayEvents.slice(0, 3).map((e) => {
                          const Icon = TYPE_ICON[e.type];
                          return (
                            <div
                              key={e.id}
                              className="flex items-center gap-1 text-xs px-1 py-0.5 rounded truncate"
                              style={{ backgroundColor: `${e.color}20`, color: e.color }}
                              title={e.title}
                            >
                              <Icon className="size-2.5 shrink-0" />
                              <span className="truncate">{e.title}</span>
                            </div>
                          );
                        })}
                        {dayEvents.length > 3 && (
                          <div className="text-xs text-muted-foreground px-1">
                            +{dayEvents.length - 3} more
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Upcoming events list */}
      {!isLoading && events.length > 0 && (
        <Card className="border-border/60 shadow-soft">
          <CardHeader>
            <CardTitle className="text-base">{t("misc-upcoming-this-month")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {events.slice(0, 20).map((e) => {
                const Icon = TYPE_ICON[e.type];
                return (
                  <div key={e.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50 transition-colors">
                    <div
                      className="size-9 rounded-lg flex items-center justify-center shrink-0"
                      style={{ backgroundColor: `${e.color}20` }}
                    >
                      <Icon className="size-4" style={{ color: e.color }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{e.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {TYPE_LABEL[e.type]} · {new Date(e.date).toLocaleDateString("en-US", { day: "numeric", month: "short" })}
                        {e.status ? ` · ${e.status}` : ""}
                      </p>
                    </div>
                    {e.amount != null && (
                      <Badge variant="outline" className="tabular">
                        {e.currency} {e.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </Badge>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
