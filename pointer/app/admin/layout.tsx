import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { AppHeader } from "@/app/_components/app-header";
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

	return (
		<div className="flex flex-1 flex-col bg-zinc-50 font-sans text-zinc-900 dark:bg-black dark:text-zinc-50">
			<AppHeader active="/admin" />
			{children}
		</div>
	);
}
