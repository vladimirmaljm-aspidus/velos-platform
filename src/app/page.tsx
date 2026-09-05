import AppEntry from "@/components/auth/app-entry";

// Force dynamic rendering — prevents Vercel from caching any auth-screen HTML.
// The auth gate + shell swap logic lives in the shared client entry
// (src/components/auth/app-entry.tsx) so the root route and the /app/*
// catch-all render the exact same SPA surface (audit 4-d P1-1).
export const dynamic = "force-dynamic";

/**
 * Homepage / auth gate — thin wrapper around the shared SPA entry.
 * All behaviour (login/register swap, /api/auth/me + /api/portal/me shell
 * swaps) is documented on <AppEntry/>.
 */
export default function Home() {
  return <AppEntry />;
}
