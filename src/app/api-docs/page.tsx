"use client";

/**
 * Swagger UI page — served at /api-docs.
 *
 * Renders the OpenAPI spec (curated in @/lib/api/openapi-spec) via the
 * `swagger-ui-react` package. The page is client-side only because
 * swagger-ui-react uses browser-only APIs (DOM, fetch, window) and would
 * crash Next.js server-side rendering.
 *
 * ─── Access control ────────────────────────────────────────────────────────
 * The page is gated client-side: if the caller has no admin session, we
 * redirect to / (the login view). This is a UX gate, not a security gate —
 * the underlying API endpoints enforce their own permission checks
 * regardless of who is browsing the docs. The docs themselves contain no
 * secrets (the spec is also served publicly at /api/openapi-json so external
 * tools can import it).
 *
 * ─── Why dynamic import with ssr: false? ───────────────────────────────────
 * `swagger-ui-react` v5 ships ESM that references `window` at module-eval
 * time. Even though the page is marked `"use client"`, Next.js still
 * pre-renders client components on the server during the build. Wrapping
 * the import in `next/dynamic` with `ssr: false` defers the load to the
 * browser, sidestepping the SSR crash.
 */

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useAppStore, isAdmin, isSuperAdmin } from "@/lib/store/app-store";
import { Loader2, ArrowLeft, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openApiSpec } from "@/lib/api/openapi-spec";

// Swagger UI's stylesheet. Imported at module scope so Next.js bundles it
// with the page chunk and injects it via a <link> tag. The `swagger-ui.css`
// subpath is explicitly listed in the package's `exports` map, so this
// resolves correctly under NodeNext / bundler module resolution.
import "swagger-ui-react/swagger-ui.css";

// Lazy-load SwaggerUI in the browser only. `swagger-ui-react` v5 ships ESM
// that references `window` at module-eval time; even though this file is
// marked `"use client"`, Next.js still pre-renders client components on the
// server during `next build`. Wrapping the import in `next/dynamic` with
// `ssr: false` defers the load to the browser, sidestepping the SSR crash.
const SwaggerUI = dynamic(async () => {
  const mod = await import("swagger-ui-react");
  return mod.default;
}, { ssr: false, loading: () => <DocsSkeleton /> });

type AuthState = "checking" | "ok" | "denied";

export default function ApiDocsPage() {
  const user = useAppStore((s) => s.user);
  const setUser = useAppStore((s) => s.setUser);
  const [auth, setAuth] = useState<AuthState>("checking");

  // Verify the admin session on mount. The /api/auth/me endpoint returns
  // 401 when not authenticated, which we treat as "denied".
  useEffect(() => {
    let mounted = true;
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!mounted) return;
        if (data?.user) {
          setUser(data.user);
          // Only admins and super-admins see the docs. Regular sales/viewer
          // accounts get the denied state — they have no use for the API
          // spec and we don't want to advertise endpoints they can't call.
          if (isAdmin(data.user) || isSuperAdmin(data.user)) {
            setAuth("ok");
          } else {
            setAuth("denied");
          }
        } else {
          setAuth("denied");
        }
      })
      .catch(() => mounted && setAuth("denied"));
    return () => { mounted = false; };
  }, [setUser]);

  // ── Denied: redirect to login ──────────────────────────────────────────
  if (auth === "denied") {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 bg-background">
        <ShieldAlert className="size-10 text-muted-foreground" />
        <div className="text-center space-y-1">
          <h1 className="text-xl font-semibold">Admin access required</h1>
          <p className="text-sm text-muted-foreground max-w-sm">
            The API documentation is restricted to admin and super-admin
            accounts. Sign in with an admin account to continue.
          </p>
        </div>
        <Button asChild>
          <a href="/">
            <ArrowLeft className="size-4 mr-1.5" />
            Back to sign-in
          </a>
        </Button>
      </div>
    );
  }

  // ── Checking: spinner ──────────────────────────────────────────────────
  if (auth === "checking") {
    return <DocsSkeleton />;
  }

  // ── OK: render Swagger UI ──────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background">
      {/* Back-to-app bar — keeps users oriented; Swagger UI itself doesn't
          provide a "home" link. */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-4 py-2 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/75">
        <div className="flex items-center gap-2 min-w-0">
          <Button asChild variant="ghost" size="sm" className="shrink-0">
            <a href="/">
              <ArrowLeft className="size-4 mr-1.5" />
              Back to app
            </a>
          </Button>
          <span className="text-sm font-medium text-muted-foreground truncate">
            VELOS Trade API · Documentation
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground hidden sm:inline">
            Signed in as <span className="font-medium text-foreground">{user?.full_name || user?.username}</span>
          </span>
          <Button asChild variant="outline" size="sm">
            <a href="/api/openapi-json" target="_blank" rel="noopener noreferrer">
              View JSON
            </a>
          </Button>
        </div>
      </div>

      {/* Swagger UI fills the remaining viewport height. The wrapper
          inherits background/text colours from the app theme via CSS
          variables defined in globals.css. */}
      <div className="swagger-ui-wrap">
        {/* @ts-expect-error — swagger-ui-react v5 has incorrect TS types (props: {}) 
            but the component accepts spec/docExpansion/etc at runtime */}
        <SwaggerUI
          spec={openApiSpec}
          docExpansion="list"
          defaultModelExpandDepth={1}
          defaultModelsExpandDepth={1}
          filter={true}
          deepLinking={true}
          persistAuthorization={true}
          tryItOutEnabled={false}
          supportedSubmitMethods={["get", "post", "put", "delete", "patch"]}
        />
      </div>
    </div>
  );
}

/** Loading skeleton shown while the dynamic SwaggerUI chunk loads. */
function DocsSkeleton() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-background">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">Loading API documentation…</p>
    </div>
  );
}
