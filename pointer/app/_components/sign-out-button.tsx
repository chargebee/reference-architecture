"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
	const router = useRouter();
	const [pending, setPending] = useState(false);

	async function onClick() {
		setPending(true);
		await authClient.signOut();
		router.push("/");
		router.refresh();
	}

	return (
		<button
			type="button"
			onClick={onClick}
			disabled={pending}
			className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-800 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-900"
		>
			{pending ? "Signing out…" : "Sign out"}
		</button>
	);
}
