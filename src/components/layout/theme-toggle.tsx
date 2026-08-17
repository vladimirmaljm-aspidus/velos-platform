"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => setMounted(true), []);

  const isDark = resolvedTheme === "dark";

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="relative rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/60 smooth overflow-hidden"
    >
      {/* Reserve layout space until mounted to avoid hydration mismatch */}
      {!mounted ? (
        <span className="size-5" aria-hidden />
      ) : (
        <>
          <Sun
            className={cn(
              "size-5 absolute smooth transition-all duration-300",
              isDark
                ? "rotate-0 scale-100 opacity-100"
                : "rotate-90 scale-0 opacity-0",
            )}
          />
          <Moon
            className={cn(
              "size-5 absolute smooth transition-all duration-300",
              isDark
                ? "-rotate-90 scale-0 opacity-0"
                : "rotate-0 scale-100 opacity-100",
            )}
          />
        </>
      )}
    </Button>
  );
}
