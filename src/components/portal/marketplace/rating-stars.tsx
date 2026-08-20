"use client";

import { useState } from "react";
import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

export interface RatingStarsProps {
  /** Current rating value (0–5, may be a fraction for display-only mode — e.g. 4.7). */
  value: number;
  /** When true (default), the stars are read-only. When false, the user can click 1–5. */
  readOnly?: boolean;
  /** Size variant — `sm` (cards), `md` (default), `lg` (hero areas). */
  size?: "sm" | "md" | "lg";
  /** Optional callback fired when the user clicks a star (interactive mode only). */
  onRatingChange?: (rating: number) => void;
  /** Optional aria-label for the rating control. */
  ariaLabel?: string;
  /** Optional className applied to the wrapping div. */
  className?: string;
}

const SIZE_CLS: Record<NonNullable<RatingStarsProps["size"]>, string> = {
  sm: "h-3 w-3",
  md: "h-4 w-4",
  lg: "h-5 w-5",
};

const GAP_CLS: Record<NonNullable<RatingStarsProps["size"]>, string> = {
  sm: "gap-0.5",
  md: "gap-1",
  lg: "gap-1.5",
};

/**
 * RatingStars — five-star rating display.
 *
 * Display mode (readOnly=true, default):
 *   Renders 5 stars, each fully coloured when value >= index+1, half-filled
 *   (CSS-only approximation) when the fractional part is >= 0.25 and < 0.75,
 *   and fully coloured when the fractional part >= 0.75. Empty stars are
 *   muted-foreground. Used on the company profile page header + each review
 *   card.
 *
 * Interactive mode (readOnly=false):
 *   Renders 5 clickable stars that highlight on hover. The user's click
 *   fires `onRatingChange(integer 1–5)`. Used by the Write-a-Review dialog.
 *
 * Half-star rendering is approximated via two absolutely-positioned Star
 * icons — the lower one (muted) under the upper one (filled) clipped to a
 * percentage width. This avoids pulling an SVG icon library and keeps the
 * component dependency-free.
 */
export function RatingStars({
  value,
  readOnly = true,
  size = "md",
  onRatingChange,
  ariaLabel,
  className,
}: RatingStarsProps) {
  const [hover, setHover] = useState<number | null>(null);
  const display = hover ?? value;

  const starCls = SIZE_CLS[size];
  const gapCls = GAP_CLS[size];

  return (
    <div
      className={cn("inline-flex items-center", gapCls, className)}
      role={readOnly ? "img" : "radiogroup"}
      aria-label={ariaLabel || `Rating ${value} of 5`}
    >
      {[1, 2, 3, 4, 5].map((i) => {
        // Fraction filled = how much of this star should be coloured.
        // 1.0 when value >= i, 0 when value < i - 1, otherwise (value - (i-1)).
        let fraction = 0;
        if (display >= i) fraction = 1;
        else if (display > i - 1) fraction = display - (i - 1);
        // Cap to [0, 1].
        fraction = Math.max(0, Math.min(1, fraction));

        const isInteractive = !readOnly;

        return (
          <button
            key={i}
            type="button"
            disabled={readOnly}
            onClick={() => !readOnly && onRatingChange?.(i)}
            onMouseEnter={() => !readOnly && setHover(i)}
            onMouseLeave={() => !readOnly && setHover(null)}
            className={cn(
              "relative inline-block",
              isInteractive && "cursor-pointer hover:scale-110 transition-transform",
              readOnly && "cursor-default",
            )}
            aria-label={`${i} ${i === 1 ? "star" : "stars"}`}
            aria-pressed={!readOnly && display === i}
          >
            {/* Background (empty) star — always rendered, muted colour. */}
            <Star
              className={cn(starCls, "text-muted-foreground/40")}
              fill="currentColor"
              strokeWidth={0}
            />
            {/* Foreground (filled) star — clipped to `fraction` width. */}
            {fraction > 0 && (
              <span
                className="absolute inset-0 overflow-hidden"
                style={{ width: `${fraction * 100}%` }}
                aria-hidden="true"
              >
                <Star
                  className={cn(starCls, "text-amber-500")}
                  fill="currentColor"
                  strokeWidth={0}
                />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
