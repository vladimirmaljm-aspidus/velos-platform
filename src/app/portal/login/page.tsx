import { Suspense } from "react";
import { PortalLogin } from "@/components/portal/portal-login";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Client Portal — VELOS",
  description: "Secure client workspace",
};

export default function PortalLoginPage() {
  return (
    <Suspense fallback={null}>
      <PortalLogin />
    </Suspense>
  );
}
