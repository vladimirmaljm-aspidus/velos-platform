import { Suspense } from "react";
import { PortalLogin } from "@/components/portal/portal-login";

// FIX-ALL-2 / Fix 2 — dedicated /portal/setup-password route.
//
// Same rationale as /portal/forgot-password/page.tsx: previously the
// link from a portal-invite email (`/portal/setup-password?
// setup_token=…`) fell through to the `[...catchAll]` route which
// redirected to the admin SPA at `/`. The user saw the admin sign-in
// page instead of the password-setup form, and reported "nothing
// happens".
//
// This route renders the PortalLogin component with
// `initialDialog="setup"`. The component ALSO reads the
// `?setup_token=`, `?access_id=`, and `?reset_token=` URL params
// (audit F-6/P1-3) — those take precedence over the `initialDialog`
// prop so a deep link carrying a setup_token still opens the setup
// dialog with the token pre-filled.

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Set up your password — VELOS Client Portal",
  description: "Activate your VELOS client workspace",
};

export default function PortalSetupPasswordPage() {
  return (
    <Suspense fallback={null}>
      <PortalLogin initialDialog="setup" />
    </Suspense>
  );
}
