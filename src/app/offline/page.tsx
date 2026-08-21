import Link from "next/link";
import Image from "next/image";
import { Button } from "@/components/ui/button";

export const metadata = {
  title: "Offline",
  description: "You are offline — VELOS will reconnect automatically.",
  robots: { index: false, follow: false },
};

/**
 * Offline fallback page.
 *
 * Served by the Service Worker's `networkFirst` navigation handler when the
 * network is unreachable AND the requested URL isn't already cached. The
 * "Try Again" button forces a full reload of the original URL — if the
 * network has returned, the SW will serve the live page; if not, the user
 * lands back here.
 *
 * This page must be self-contained (no client hooks, no React Query, no
 * auth context) so it renders reliably even when everything else is down.
 * It's server-rendered and precached by the SW on install, so it loads
 * instantly offline.
 */
export default function OfflinePage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="text-center max-w-md">
        <Image
          src="/logo.svg"
          alt="VELOS"
          width={72}
          height={72}
          priority
          className="mx-auto mb-6"
          style={{ width: 72, height: 72 }}
        />
        <h1 className="text-3xl font-bold text-foreground mb-2">
          You&rsquo;re Offline
        </h1>
        <p className="text-sm text-muted-foreground mb-8 leading-relaxed">
          VELOS can&rsquo;t reach the server right now. Your cached data is
          still available, and any changes you make will sync automatically
          when the connection returns.
        </p>
        <Button asChild className="gap-2">
          <Link href="/">
            Try Again
          </Link>
        </Button>
      </div>
    </div>
  );
}
