"use client";

import { useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Users, MessageSquare, Calendar, Newspaper } from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { GroupList } from "./group-list";
import { QuestionList } from "./question-list";
import { EventCalendar } from "./event-calendar";
import { BlogFeed } from "./blog-feed";

/**
 * Community hub — top-level surface for Marketplace Phase 10.
 *
 * The hub uses Tabs to switch between the four community surfaces
 * (Groups / Q&A / Events / Blog). Each tab renders its own data-
 * fetching child component; the hub stays mostly stateless except for
 * the active-tab state.
 *
 * v1 deliberately keeps the "Create X" affordances as no-ops — they're
 * stubbed here so the cards have a complete visual structure, but the
 * create flows (group create dialog, question editor, event create,
 * blog editor) are deferred to a follow-up iteration. The handlers
 * receive the click intent and currently just no-op; this keeps the
 * data surfaces fully wired while we gather usage signal before
 * building the editor flows.
 */
export function CommunityHub() {
  const t = useT();
  const [tab, setTab] = useState("groups");

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
          <GroupList onCreateClick={undefined} />
        </TabsContent>
        <TabsContent value="qa" className="mt-4">
          <QuestionList onCreateClick={undefined} />
        </TabsContent>
        <TabsContent value="events" className="mt-4">
          <EventCalendar onCreateClick={undefined} />
        </TabsContent>
        <TabsContent value="blog" className="mt-4">
          <BlogFeed onCreateClick={undefined} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
