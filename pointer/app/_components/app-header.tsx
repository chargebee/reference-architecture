import { headers } from "next/headers";
import Image from "next/image";
import Link from "next/link";

import { isAdminRequest } from "@/lib/admin";

import { SignOutButton } from "./sign-out-button";

/**
 * The chrome every signed-in page wears. Signed-out pages have their own
 * header, since none of these targets exist without a session.
 */

/** Each page names its own nav target, which spares the nav a client hook. */
export type AppNavTarget = "/admin" | "/usage" | "/choose-plan";

type NavItem = { href: AppNavTarget; label: string };

const NAV: NavItem[] = [
	{ href: "/usage", label: "Usage" },
	{ href: "/choose-plan", label: "Manage plan" },
];

const ADMIN_NAV: NavItem = { href: "/admin", label: "Admin" };

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
	return (
		<Link
			href={item.href}
			aria-current={active ? "page" : undefined}
			className={`rounded-full px-4 py-2 transition-colors ${
				active
					? "bg-black/[.06] text-zinc-900 dark:bg-white/[.08] dark:text-zinc-50"
					: "text-zinc-700 hover:bg-black/[.05] dark:text-zinc-300 dark:hover:bg-white/[.06]"
			}`}
		>
			{item.label}
		</Link>
	);
}

export async function AppHeader({ active }: { active?: AppNavTarget }) {
	const isAdmin = await isAdminRequest(await headers());
	const items = isAdmin ? [ADMIN_NAV, ...NAV] : NAV;

	return (
		<header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
			<Link href="/">
				<Image
					src="/pointer-lockup-white.svg"
					alt="Pointer"
					width={140}
					height={40}
					priority
				/>
			</Link>

			<nav className="flex items-center gap-3 text-sm font-medium">
				{items.map((item) => (
					<NavLink key={item.href} item={item} active={item.href === active} />
				))}
				<SignOutButton />
			</nav>
		</header>
	);
}
