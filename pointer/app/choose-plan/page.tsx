import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { PlanPicker } from "@/app/choose-plan/_components/plan-picker";
import { auth } from "@/lib/auth";
import { getActiveUserSubscription } from "@/lib/subscriptions";

export default async function ChoosePlanPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in?from=/choose-plan");

  const activeSubscription = await getActiveUserSubscription(session.user.id);
  const mode = activeSubscription ? "switch" : "choose";

  return (
    <div className="min-h-screen bg-zinc-50 font-sans text-zinc-900 dark:bg-black dark:text-zinc-50">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        <Link
          href="/"
          className="text-sm font-medium text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          &larr; Pointer
        </Link>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Signed in as {session.user.email}
        </p>
      </header>

      <main className="mx-auto w-full max-w-6xl px-6 pb-24">
        <PlanPicker mode={mode} activeSubscription={activeSubscription} />
      </main>
    </div>
  );
}
