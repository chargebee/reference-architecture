import Link from "next/link";
import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
	return (
		<div className="flex flex-1 items-center justify-center bg-zinc-50 px-4 py-12 dark:bg-black">
			<div className="w-full max-w-sm">
				<Link
					href="/"
					className="mb-8 block text-sm font-medium text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
				>
					&larr; Back home
				</Link>
				<div className="rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
					{children}
				</div>
			</div>
		</div>
	);
}
