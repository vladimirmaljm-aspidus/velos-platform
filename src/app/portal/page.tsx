import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function PortalRootPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; access_id?: string }>;
}) {
  // Redirect to login page, preserving any query params (email, access_id)
  return (async () => {
    const sp = await searchParams;
    const qs = new URLSearchParams();
    if (sp.email) qs.set("email", sp.email);
    if (sp.access_id) qs.set("access_id", sp.access_id);
    const tail = qs.toString();
    redirect(tail ? `/portal/login?${tail}` : "/portal/login");
  })();
}
