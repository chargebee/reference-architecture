import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

import { SignOutButton } from "../_components/sign-out-button";

export default async function DashboardPage() {
  // The proxy already redirects unauthenticated requests, but we re-verify
  // here against the DB because proxy only checks cookie presence.
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in?from=/dashboard");

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-16">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Dashboard
          </h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Protected by Better Auth. You can only see this when signed in.
          </p>
        </div>
        <SignOutButton />
      </div>

      <dl className="mt-8 grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
        <Stat label="User ID" value={session.user.id} />
        <Stat label="Email" value={session.user.email} />
        <Stat label="Name" value={session.user.name || "—"} />
        <Stat
          label="Email verified"
          value={session.user.emailVerified ? "Yes" : "No"}
        />
        <Stat
          label="Session expires"
          value={new Date(session.session.expiresAt).toLocaleString()}
        />
      </dl>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <dt className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {label}
      </dt>
      <dd className="mt-1 font-mono text-zinc-900 dark:text-zinc-100">
        {value}
      </dd>
    </div>
  );
}
