"use client";

import { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbEllipsis,
} from "@/components/ui/breadcrumb";

/* ─── Breadcrumb Item Type ─────────────────────────────────────────────── */
export interface BreadcrumbItemData {
  label: string;
  href?: string;
}

/* ─── PageHeader ───────────────────────────────────────────────────────── */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
  gradient = false,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;

  /** Optional breadcrumb trail rendered above the title */
  breadcrumbs?: BreadcrumbItemData[];

  /** Apply the brand gradient to the title. @default false — plain foreground reads more corporate. */
  gradient?: boolean;

  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1 mb-8 animate-fade-in",
        className,
      )}
    >
      {/* ── Breadcrumbs ─────────────────────────────────────── */}
      {breadcrumbs && breadcrumbs.length > 0 && (
        <Breadcrumb className="mb-1">
          <BreadcrumbList className="text-xs">
            {breadcrumbs.map((crumb, idx) => {
              const isLast = idx === breadcrumbs.length - 1;

              return (
                <span key={idx} className="contents">
                  <BreadcrumbItem>
                    {isLast ? (
                      <BreadcrumbPage className="text-xs font-medium text-foreground/70">
                        {crumb.label}
                      </BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink
                        href={crumb.href}
                        className="text-xs text-muted-foreground hover:text-foreground smooth"
                      >
                        {crumb.label}
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                  {!isLast && <BreadcrumbSeparator />}
                </span>
              );
            })}
          </BreadcrumbList>
        </Breadcrumb>
      )}

      {/* ── Title + Actions Row ─────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1
            className={cn(
              "text-2xl font-bold tracking-tight leading-tight",
              gradient && "text-gradient-emerald",
            )}
          >
            {title}
          </h1>
          {description && (
            <p className="text-sm text-muted-foreground leading-relaxed max-w-2xl">
              {description}
            </p>
          )}
        </div>

        {actions && (
          <div className="flex flex-wrap items-center gap-2 shrink-0 sm:flex-nowrap sm:pb-0.5">
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}
