"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Loader2,
  Building2,
  Globe2,
  MapPin,
  Calendar,
  Users,
  Award,
  Link as LinkIcon,
  Star,
  Package,
  Handshake,
  TrendingUp,
  UserPlus,
  UserCheck,
  PenLine,
  MessageSquare,
  ExternalLink,
  Send,
} from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { toast } from "sonner";
import { fmtDateTime, fmtRelative } from "@/lib/utils/format";
import { COUNTRIES } from "@/lib/data/reference";
import { VerificationBadge } from "./verification-badge";
import { RatingStars } from "./rating-stars";
import { ESGRating } from "./esg-rating";
import { SustainabilityCerts } from "./sustainability-certs";
import { CarbonOffsetWidget } from "./carbon-offset-widget";
import type { MarketplaceVerificationLevel } from "@/lib/supabase/marketplace-profile-types";

interface PublicProfile {
  id: string;
  partner_id: string;
  company_description: string | null;
  year_established: number | null;
  number_of_employees: string | null;
  website: string | null;
  linkedin_url: string | null;
  certifications: Array<{ name?: string; issuer?: string; year?: number | string }> | null;
  export_markets: string[] | null;
  main_products: Array<{ name?: string; category?: string }> | null;
  verification_level: MarketplaceVerificationLevel;
  verified_at: string | null;
  verified_by: string | null;
  total_posts: number;
  total_responses: number;
  successful_deals: number;
  rating_average: number;
  rating_count: number;
  viewer_follows?: boolean;
  created_at: string;
  updated_at: string;
}

interface PublicPartner {
  name?: string;
  country?: string | null;
  city?: string | null;
  website?: string | null;
}

interface ReviewItem {
  id: string;
  reviewed_partner_id: string;
  reviewer_partner_id?: string; // only present when caller is the reviewed company
  post_id: string | null;
  rating: number;
  review_text: string | null;
  response_text: string | null;
  response_at: string | null;
  is_public: boolean;
  created_at: string;
}

interface ProfileResponse {
  profile: PublicProfile;
  partner: PublicPartner | null;
  can_review: boolean;
  viewer_is_self?: boolean;
}

/**
 * CompanyProfile — the public-facing company page for a marketplace partner.
 *
 * Renders:
 *   - Hero card with company name, country, year established, employees,
 *     verification badge, rating stars + count, success metrics
 *     (posts/deals/success rate).
 *   - Follow button (POST/DELETE /api/marketplace/follow).
 *   - Description card.
 *   - Main products card.
 *   - Export markets card.
 *   - Certifications card.
 *   - Reviews section (list with rating + text + company response).
 *   - "Write a Review" button (only when `can_review` is true — i.e. the
 *     caller has a completed deal with this company and is not the
 *     company itself).
 *
 * The component is rendered by /portal/marketplace/company/[partnerId]/page.tsx
 * inside PortalShell. The partnerId is passed as a prop.
 */
export function CompanyProfile({ partnerId }: { partnerId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const [showReviewForm, setShowReviewForm] = useState(false);
  const [reviewDraft, setReviewDraft] = useState({ rating: 5, review_text: "" });
  const [responseDrafts, setResponseDrafts] = useState<Record<string, string>>({});
  const [respondingToId, setRespondingToId] = useState<string | null>(null);

  const profileQ = useQuery<ProfileResponse>({
    queryKey: ["marketplace-company-profile", partnerId],
    queryFn: async () => {
      const r = await fetch(`/api/marketplace/profiles/${partnerId}`);
      if (!r.ok) {
        if (r.status === 404) throw new Error("not-found");
        throw new Error("failed");
      }
      return r.json();
    },
  });

  const reviewsQ = useQuery<{ items: ReviewItem[] }>({
    queryKey: ["marketplace-company-reviews", partnerId],
    queryFn: async () => {
      const r = await fetch(`/api/marketplace/reviews?partnerId=${partnerId}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });

  // ── Follow / unfollow ──────────────────────────────────────────────────
  const followMut = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/marketplace/follow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ followed_partner_id: partnerId }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to follow.");
      }
    },
    onSuccess: () => {
      toast.success(t("marketplace-follow-added"));
      qc.invalidateQueries({ queryKey: ["marketplace-company-profile", partnerId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const unfollowMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/marketplace/follow?partnerId=${partnerId}`, { method: "DELETE" });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to unfollow.");
      }
    },
    onSuccess: () => {
      toast.success(t("marketplace-follow-removed"));
      qc.invalidateQueries({ queryKey: ["marketplace-company-profile", partnerId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ── Write review ───────────────────────────────────────────────────────
  const createReviewMut = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/marketplace/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reviewed_partner_id: partnerId,
          rating: reviewDraft.rating,
          review_text: reviewDraft.review_text || null,
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to submit review.");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("marketplace-review-submitted"));
      setShowReviewForm(false);
      setReviewDraft({ rating: 5, review_text: "" });
      qc.invalidateQueries({ queryKey: ["marketplace-company-reviews", partnerId] });
      qc.invalidateQueries({ queryKey: ["marketplace-company-profile", partnerId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ── Respond to a review ───────────────────────────────────────────────
  const respondMut = useMutation({
    mutationFn: async (reviewId: string) => {
      const text = responseDrafts[reviewId] || "";
      const r = await fetch(`/api/marketplace/reviews/${reviewId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response_text: text }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to respond.");
      }
      return r.json();
    },
    onSuccess: (_data, reviewId) => {
      toast.success(t("marketplace-response-submitted"));
      setRespondingToId(null);
      setResponseDrafts((d) => ({ ...d, [reviewId]: "" }));
      qc.invalidateQueries({ queryKey: ["marketplace-company-reviews", partnerId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ── Render ─────────────────────────────────────────────────────────────
  if (profileQ.isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (profileQ.isError || !profileQ.data?.profile) {
    return (
      <div className="text-center py-20">
        <Building2 className="h-12 w-12 text-muted-foreground mx-auto mb-3 opacity-50" />
        <p className="text-muted-foreground">{t("marketplace-company-not-found")}</p>
      </div>
    );
  }

  const { profile, partner, can_review } = profileQ.data;
  // `viewer_is_self` is the canonical "the viewer IS the company itself"
  // signal — the company can add/delete their own sustainability certs
  // and create carbon offsets only when this is true. The check is done
  // server-side (access.partner_id === partnerId) and surfaced via the
  // profile API response so the client doesn't need a second round-trip.
  const viewerIsSelf = Boolean(profileQ.data.viewer_is_self);
  // Portal sessions are never super-admin (super-admin is a CRM-only role).
  // The "Verify" button on the sustainability-certs component is wired to
  // PUT /api/marketplace/esg/certs/[id] with `verified: true`, which
  // enforces requireSuperAdmin — so we just hide the button on the portal
  // surface; CRM admins verify via the super-admin route.
  const canVerify = false;
  // Preserve the legacy isSelf variable for the existing Follow / Respond
  // code paths — same semantics as viewerIsSelf.
  const isSelf = viewerIsSelf;
  const country = partner?.country ? COUNTRIES.find((c) => c.code === partner.country) : null;
  const totalResponses = profile.total_responses || 0;
  const successful = profile.successful_deals || 0;
  const successRate = totalResponses > 0 ? Math.round((successful / totalResponses) * 100) : 0;

  const reviews = reviewsQ.data?.items ?? [];

  return (
    <div className="space-y-6">
      {/* Hero card */}
      <Card>
        <CardContent className="p-6 space-y-5">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="size-14 rounded-md bg-primary/10 text-primary flex items-center justify-center">
                <Building2 className="size-7" />
              </div>
              <div>
                <h1 className="text-2xl font-bold">{partner?.name || t("marketplace-unknown-company")}</h1>
                <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1 flex-wrap">
                  {country && (
                    <span className="inline-flex items-center gap-1">
                      <Globe2 className="h-3.5 w-3.5" />
                      {country.name}
                    </span>
                  )}
                  {partner?.city && (
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="h-3.5 w-3.5" />
                      {partner.city}
                    </span>
                  )}
                  {profile.year_established && (
                    <span className="inline-flex items-center gap-1">
                      <Calendar className="h-3.5 w-3.5" />
                      {t("marketplace-established-in").replace("{year}", String(profile.year_established))}
                    </span>
                  )}
                  {profile.number_of_employees && (
                    <span className="inline-flex items-center gap-1">
                      <Users className="h-3.5 w-3.5" />
                      {profile.number_of_employees} {t("marketplace-employees").toLowerCase()}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <VerificationBadge level={profile.verification_level} size="md" />
            </div>
          </div>

          {/* Rating + success metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-2 border-t">
            <div>
              <p className="text-xs text-muted-foreground">{t("marketplace-rating")}</p>
              <div className="flex items-center gap-2 mt-1">
                <RatingStars value={profile.rating_average || 0} size="md" />
                <span className="text-sm font-medium">
                  {(profile.rating_average || 0).toFixed(1)}
                </span>
                <span className="text-xs text-muted-foreground">
                  ({profile.rating_count || 0})
                </span>
              </div>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t("marketplace-total-posts")}</p>
              <p className="font-medium mt-1 flex items-center gap-1">
                <Package className="h-3.5 w-3.5 text-muted-foreground" />
                {profile.total_posts || 0}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t("marketplace-successful-deals")}</p>
              <p className="font-medium mt-1 flex items-center gap-1">
                <Handshake className="h-3.5 w-3.5 text-muted-foreground" />
                {successful}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t("marketplace-success-rate")}</p>
              <p className="font-medium mt-1 flex items-center gap-1">
                <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
                {successRate}%
              </p>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 flex-wrap pt-2 border-t">
            {!isSelf && (
              profile.viewer_follows ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => unfollowMut.mutate()}
                  disabled={unfollowMut.isPending}
                >
                  {unfollowMut.isPending ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <UserCheck className="h-4 w-4 mr-1" />
                  )}
                  {t("marketplace-following")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() => followMut.mutate()}
                  disabled={followMut.isPending}
                >
                  {followMut.isPending ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <UserPlus className="h-4 w-4 mr-1" />
                  )}
                  {t("marketplace-follow")}
                </Button>
              )
            )}

            {profile.website && (
              <Button variant="ghost" size="sm" asChild>
                <a href={profile.website} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4 mr-1" />
                  {t("marketplace-website")}
                </a>
              </Button>
            )}
            {profile.linkedin_url && (
              <Button variant="ghost" size="sm" asChild>
                <a href={profile.linkedin_url} target="_blank" rel="noopener noreferrer">
                  <LinkIcon className="h-4 w-4 mr-1" />
                  LinkedIn
                </a>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Description */}
      {profile.company_description && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("marketplace-about-company")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm whitespace-pre-wrap">{profile.company_description}</p>
          </CardContent>
        </Card>
      )}

      {/* Products + Markets + Certifications */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Package className="h-4 w-4" />
              {t("marketplace-main-products")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {Array.isArray(profile.main_products) && profile.main_products.length > 0 ? (
              <ul className="space-y-1.5 text-sm">
                {profile.main_products.map((p, i) => (
                  <li key={i} className="flex items-start justify-between gap-2">
                    <span>{p.name || "—"}</span>
                    {p.category && (
                      <Badge variant="outline" className="text-xs">{p.category}</Badge>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t("marketplace-no-products")}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Globe2 className="h-4 w-4" />
              {t("marketplace-export-markets")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {Array.isArray(profile.export_markets) && profile.export_markets.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {profile.export_markets.map((code, i) => {
                  const c = COUNTRIES.find((x) => x.code === code);
                  return (
                    <Badge key={i} variant="outline" className="text-xs">
                      <Globe2 className="h-3 w-3 mr-1" />
                      {c?.name || code}
                    </Badge>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t("marketplace-no-markets")}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Award className="h-4 w-4" />
              {t("marketplace-certifications")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {Array.isArray(profile.certifications) && profile.certifications.length > 0 ? (
              <ul className="space-y-1.5 text-sm">
                {profile.certifications.map((c, i) => (
                  <li key={i} className="flex items-start justify-between gap-2">
                    <span className="flex items-start gap-1.5">
                      <Award className="h-3.5 w-3.5 text-amber-500 mt-0.5 shrink-0" />
                      <span>
                        <span className="font-medium">{c.name || "—"}</span>
                        {c.issuer && (
                          <span className="block text-xs text-muted-foreground">{c.issuer}</span>
                        )}
                      </span>
                    </span>
                    {c.year && (
                      <span className="text-xs text-muted-foreground">{String(c.year)}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t("marketplace-no-certifications")}</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ESG section — rating + sustainability certs + carbon offsets.
          Added in Phase 11. The ESG rating is public (any viewer sees it).
          Sustainability certs are public-read; the Add/Delete affordances
          only show for the company owner. The carbon-offset widget is
          private to the owner (the offset transactions are not public). */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ESGRating partnerId={partnerId} />
        <SustainabilityCerts
          partnerId={partnerId}
          canEdit={viewerIsSelf}
          canVerify={canVerify}
        />
      </div>
      {viewerIsSelf && (
        <CarbonOffsetWidget partnerId={partnerId} isSelf />
      )}

      {/* Reviews section */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Star className="h-4 w-4" />
              {t("marketplace-reviews-title")}
              <Badge variant="outline" className="text-xs ml-1">
                {profile.rating_count || 0}
              </Badge>
            </CardTitle>
            {!isSelf && can_review && !showReviewForm && (
              <Button size="sm" onClick={() => setShowReviewForm(true)}>
                <PenLine className="h-4 w-4 mr-1" />
                {t("marketplace-write-review")}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {showReviewForm && (
            <div className="space-y-3 p-4 rounded-md border bg-muted/30">
              <div>
                <Label className="text-sm">{t("marketplace-your-rating")}</Label>
                <div className="mt-2">
                  <RatingStars
                    value={reviewDraft.rating}
                    readOnly={false}
                    size="lg"
                    onRatingChange={(r) => setReviewDraft({ ...reviewDraft, rating: r })}
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="rv-text" className="text-sm">{t("marketplace-your-review")}</Label>
                <Textarea
                  id="rv-text"
                  rows={4}
                  value={reviewDraft.review_text}
                  onChange={(e) => setReviewDraft({ ...reviewDraft, review_text: e.target.value })}
                  maxLength={5000}
                  placeholder={t("marketplace-review-placeholder")}
                />
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => createReviewMut.mutate()}
                  disabled={createReviewMut.isPending}
                >
                  {createReviewMut.isPending ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4 mr-1" />
                  )}
                  {t("marketplace-submit-review")}
                </Button>
                <Button variant="outline" onClick={() => setShowReviewForm(false)}>
                  {t("portal-action-cancel")}
                </Button>
              </div>
            </div>
          )}

          {reviewsQ.isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : reviews.length === 0 ? (
            <div className="text-center py-8">
              <MessageSquare className="h-10 w-10 text-muted-foreground mx-auto mb-2 opacity-50" />
              <p className="text-sm text-muted-foreground">{t("marketplace-no-reviews")}</p>
            </div>
          ) : (
            <ul className="space-y-3">
              {reviews.map((r) => {
                const isResponding = respondingToId === r.id;
                return (
                  <li key={r.id} className="p-4 rounded-md border space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <RatingStars value={r.rating} size="sm" />
                      <span className="text-xs text-muted-foreground">
                        {fmtRelative(r.created_at)}
                      </span>
                    </div>
                    {r.review_text && (
                      <p className="text-sm whitespace-pre-wrap">{r.review_text}</p>
                    )}
                    {/* Company response (already posted) */}
                    {r.response_text && (
                      <div className="pl-3 border-l-2 border-primary/30 mt-2">
                        <p className="text-xs font-medium mb-1">
                          {t("marketplace-company-response")}
                          {r.response_at && (
                            <span className="text-muted-foreground ml-2">
                              · {fmtDateTime(r.response_at)}
                            </span>
                          )}
                        </p>
                        <p className="text-sm whitespace-pre-wrap text-muted-foreground">
                          {r.response_text}
                        </p>
                      </div>
                    )}
                    {/* Response form (only for the reviewed company) */}
                    {isSelf && !r.response_text && (
                      <div className="mt-2">
                        {!isResponding ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setRespondingToId(r.id);
                              setResponseDrafts((d) => ({ ...d, [r.id]: d[r.id] || "" }));
                            }}
                          >
                            <PenLine className="h-3.5 w-3.5 mr-1" />
                            {t("marketplace-respond")}
                          </Button>
                        ) : (
                          <div className="space-y-2 pt-1">
                            <Textarea
                              rows={3}
                              value={responseDrafts[r.id] || ""}
                              onChange={(e) =>
                                setResponseDrafts((d) => ({ ...d, [r.id]: e.target.value }))
                              }
                              placeholder={t("marketplace-response-placeholder")}
                              maxLength={5000}
                            />
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                onClick={() => respondMut.mutate(r.id)}
                                disabled={respondMut.isPending || !(responseDrafts[r.id] || "").trim()}
                              >
                                {respondMut.isPending ? (
                                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                                ) : (
                                  <Send className="h-3.5 w-3.5 mr-1" />
                                )}
                                {t("marketplace-submit-response")}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setRespondingToId(null)}
                              >
                                {t("portal-action-cancel")}
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
