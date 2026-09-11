import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { FlowCanvas } from "./_components/FlowCanvas";

export default async function AdminFlowPage() {
	// The /admin layout enforces the session and the admin permission.
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session) redirect("/sign-in?from=/admin/flow");

	return (
		<div className="flex min-h-0 w-full flex-1 flex-col">
			<header className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-3 dark:border-zinc-800 dark:bg-zinc-950">
				<div>
					<h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
						Pointer ↔ Chargebee flow
					</h1>
					<p className="text-xs text-zinc-500 dark:text-zinc-400">
						Live broadcast of internal events from the Redis stream.
					</p>
				</div>
				<span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
					{session.user.email}
				</span>
			</header>
			<FlowCanvas />
		</div>
	);
}
