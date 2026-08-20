import { RegisterView } from "@/components/auth/register-view";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Create your workspace — VELOS",
  description:
    "Start your 14-day free trial of VELOS Trade Management Platform. No credit card required.",
};

/**
 * Dedicated /register route — deep-linkable sign-up surface that mirrors the
 * homepage's auth screen. Renders <RegisterView/> with no onSwitchToLogin
 * prop, so the "Sign in" link navigates back to "/" (the homepage auth
 * gate) instead of toggling state in place.
 */
export default function RegisterPage() {
  return <RegisterView />;
}
