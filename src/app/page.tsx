"use client";

import { useEffect, useState } from "react";
import { useAppStore } from "@/lib/store/app-store";
import { LoginView } from "@/components/auth/login-view";
import { AppShell } from "@/components/layout/app-shell";
import { PortalLogin } from "@/components/portal/portal-login";
import { PortalShell } from "@/components/portal/portal-shell";
import { Loader2 } from "lucide-react";

// Force dynamic rendering — prevents Vercel from caching the loading spinner
export const dynamic = "force-dynamic";

export default function Home() {
  const user = useAppStore((s) => s.user);
  const setUser = useAppStore((s) => s.setUser);
  const portalAccess = useAppStore((s) => s.portalAccess);
  const setPortalAccess = useAppStore((s) => s.setPortalAccess);
  const appMode = useAppStore((s) => s.appMode);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let mounted = true;
    // Check admin session
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((data) => {
        if (mounted) {
          if (data.user) setUser(data.user);
          setChecking(false);
        }
      })
      .catch(() => mounted && setChecking(false));

    // Check portal session (in parallel)
    fetch("/api/portal/me")
      .then((r) => r.json())
      .then((data) => {
        if (mounted && data.access) setPortalAccess(data.access);
      })
      .catch(() => {});
    return () => { mounted = false; };
  }, [setUser, setPortalAccess]);

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Portal mode takes precedence if portal session exists
  if (appMode === "portal" || portalAccess) {
    return portalAccess ? <PortalShell /> : <PortalLogin />;
  }

  return user ? <AppShell /> : <LoginView />;
}
