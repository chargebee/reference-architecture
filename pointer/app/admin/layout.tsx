import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { isAdminRequest } from "@/lib/admin";
import { auth } from "@/lib/auth";

/**
 * Gate for every route under /admin. The proxy only checks cookie presence, so
 * the session is re-verified against the DB here, and the admin permission check
 * runs once for the whole segment rather than per page.
 */
export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/sign-in?from=/admin");
  if (!(await isAdminRequest(requestHeaders))) redirect("/");

  return <>{children}</>;
}
