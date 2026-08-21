import { Suspense } from "react";
import { PortalLogin } from "@/components/portal/portal-login";

// FIX-ALL-2 / Fix 2 — dedicated /portal/forgot-password route.
//
// Audit Part D / P0 #1 found that direct navigation to
// /portal/forgot-password and /portal/setup-password hit the
// `[...catchAll]` route which `redirect("/")` — dumping the client
// onto the ADMIN sign-in page instead of opening the portal's
// password-recovery form. The "Forgot your password?" link on the
// portal login screen therefore appeared broken: it sent the user
// away from the portal entirely.
//
// This route renders the PortalLogin component (the same one
// /portal/login uses) and passes `initialDialog="forgot"` so the
// forgot-password dialog auto-opens on mount. The user stays on the
// portal surface; the dialog is pre-populated with `?email=` if the
// link carried it.
//
// `force-dynamic` mirrors /portal/login so the page renders the
// client component shell on every request (no static-HTML cache).

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Reset password — VELOS Client Portal",
  description: "Recover access to your VELOS client workspace",
};

export default function PortalForgotPasswordPage() {
  return (
    <Suspense fallback={null}>
      <PortalLogin initialDialog="forgot" />
    </Suspense>
  );
}
