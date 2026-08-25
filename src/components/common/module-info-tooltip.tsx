"use client";

import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * ModuleInfoTooltip — a small info icon that shows a tooltip with an
 * explanation of what the module does and how to use it.
 *
 * Usage:
 *   <ModuleInfoTooltip
 *     title="Partners"
 *     description="Manage your business partners — buyers, suppliers, and agents. Add contact details, track deals, view history."
 *   />
 *
 * Place it next to the page title in any view:
 *   <PageHeader title="Partners" />
 *   <ModuleInfoTooltip ... />
 */
export function ModuleInfoTooltip({
  title,
  description,
  howToUse,
  className,
}: {
  title: string;
  description: string;
  howToUse?: string[];
  className?: string;
}) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`Info about ${title}`}
            className={cn(
              "inline-flex items-center justify-center size-5 rounded-full",
              "text-muted-foreground hover:text-foreground hover:bg-muted",
              "transition-colors shrink-0",
              className,
            )}
          >
            <Info className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" className="max-w-sm p-4">
          <div className="space-y-2">
            <div className="font-semibold text-sm">{title}</div>
            <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
            {howToUse && howToUse.length > 0 && (
              <div className="pt-2 border-t">
                <div className="text-xs font-medium mb-1">How to use:</div>
                <ul className="text-xs text-muted-foreground space-y-1">
                  {howToUse.map((step, i) => (
                    <li key={i} className="flex gap-1.5">
                      <span className="text-primary font-mono shrink-0">{i + 1}.</span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
