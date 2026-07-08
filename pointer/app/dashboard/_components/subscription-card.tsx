import Link from "next/link";

import { planNameFromItemPriceId } from "@/lib/self-service-plans";

type Subscription = {
  id: string;
  itemPriceId?: string | null;
  status: string;
  periodEnd?: Date | string | null;
};

function formatStatus(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function SubscriptionCard({
  subscription,
}: {
  subscription: Subscription;
}) {
  const planName =
    planNameFromItemPriceId(subscription.itemPriceId) ??
    subscription.itemPriceId ??
    "Unknown plan";

  return (
    <section className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Subscription
          </h2>
          <p className="mt-2 text-xl font-semibold text-zinc-900 dark:text-zinc-50">
            {planName}
          </p>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Status
              </dt>
              <dd className="mt-1 text-zinc-900 dark:text-zinc-100">
                {formatStatus(subscription.status)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Renews
              </dt>
              <dd className="mt-1 text-zinc-900 dark:text-zinc-100">
                {formatDate(subscription.periodEnd)}
              </dd>
            </div>
          </dl>
        </div>

        <Link
          href="/choose-plan"
          className="inline-flex h-10 shrink-0 items-center justify-center rounded-full bg-[#6E56CF] px-5 text-sm font-medium text-white transition-colors hover:bg-[#5a45b3]"
        >
          Switch plan
        </Link>
      </div>
    </section>
  );
}
