import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { getActiveUserSubscription } from "@/lib/subscriptions";

import { SignOutButton } from "../_components/sign-out-button";
import { SubscriptionCard } from "./_components/subscription-card";

export default async function AdminPage() {
  // The layout already enforces the session and the admin permission; this
  // re-read only supplies the account details rendered below.
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in?from=/admin");

  const subscription = await getActiveUserSubscription(session.user.id);

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-16">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Admin
          </h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Operator view. Only admin accounts can open this page.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="text-sm font-medium text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            Back to Pointer
          </Link>
          <SignOutButton />
        </div>
      </div>

      <div className="mt-8">
        {subscription ? (
          <SubscriptionCard subscription={subscription} />
        ) : (
          <section className="rounded-lg border border-zinc-200 p-5 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            No active subscription on this account.
          </section>
        )}
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

      <section className="mt-10">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Tools
        </h2>
        <Link
          href="/admin/flow"
          className="mt-3 flex items-start justify-between gap-4 rounded-lg border border-zinc-200 p-4 transition-colors hover:border-indigo-400 hover:bg-indigo-50/40 dark:border-zinc-800 dark:hover:border-indigo-500 dark:hover:bg-indigo-950/30"
        >
          <div>
            <div className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
              Event flow
            </div>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              Live visualization of the Pointer ↔ Chargebee event pipeline.
            </p>
          </div>
          <span aria-hidden className="text-zinc-400">
            →
          </span>
        </Link>
      </section>
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
