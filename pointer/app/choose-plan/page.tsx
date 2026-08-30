import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { AppHeader } from "@/app/_components/app-header";
import { PlanPicker } from "@/app/choose-plan/_components/plan-picker";
import { auth } from "@/lib/auth";
import { getActiveUserSubscription } from "@/lib/subscriptions";

export default async function ChoosePlanPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in?from=/choose-plan");

  const activeSubscription = await getActiveUserSubscription(session.user.id);
  const mode = activeSubscription ? "switch" : "choose";

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 font-sans text-zinc-900 dark:bg-black dark:text-zinc-50">
      <AppHeader active="/choose-plan" />

      <main className="mx-auto w-full max-w-6xl px-6 pb-24">
        <PlanPicker mode={mode} activeSubscription={activeSubscription} />
      </main>
    </div>
  );
}
