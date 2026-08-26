"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * /logout — full-page navigation logout.
 *
 * When the user clicks "Sign out", we navigate to /logout (full page
 * navigation, not fetch). This page calls the logout API and then
 * redirects to /. The full navigation guarantees the browser processes
 * the Set-Cookie: crm_session=; Max-Age=0 header from the response.
 *
 * fetch() doesn't reliably process Set-Cookie headers in all browsers
 * (especially in headless/PWA contexts), which is why we use this
 * full-navigation approach instead.
 */
export default function LogoutPage() {
  const router = useRouter();

  useEffect(() => {
    fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
    }).finally(() => {
      // Hard redirect — not router.push — so the browser does a full
      // page load and doesn't reuse any cached state.
      window.location.href = "/";
    });
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3">
        <div className="h-10 w-10 rounded-lg bg-brand/15 ring-1 ring-brand/30 animate-pulse" />
        <p className="text-sm font-medium text-muted-foreground">Signing out…</p>
      </div>
    </div>
  );
}
