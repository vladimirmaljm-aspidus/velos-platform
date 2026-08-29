"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Home, AlertCircle } from "lucide-react";
import { useT } from "@/lib/i18n/store";

export default function NotFound() {
  const t = useT();
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="text-center max-w-md">
        <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-6">
          <AlertCircle className="w-8 h-8 text-muted-foreground" />
        </div>
        <h1 className="text-6xl font-bold text-foreground mb-2">{t("not-found-code")}</h1>
        <h2 className="text-xl font-semibold text-foreground mb-3">{t("not-found-title")}</h2>
        <p className="text-sm text-muted-foreground mb-8 leading-relaxed">
          {t("not-found-desc")}
        </p>
        <Link href="/">
          <Button className="gap-2">
            <Home className="w-4 h-4" />
            {t("not-found-back")}
          </Button>
        </Link>
      </div>
    </div>
  );
}
