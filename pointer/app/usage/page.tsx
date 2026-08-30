import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { resolveEntitlements } from "@/lib/entitlements/features";
import { getUsageSnapshot } from "@/lib/entitlements/gate";
import { resolveEntitlementSubject } from "@/lib/entitlements/subject";
import { usageIngestEnabled } from "@/lib/usage/events";
import {
  isUsageRange,
  resolveUsageRange,
  type UsageRange,
  type UsageRangeKey,
} from "@/lib/usage/ranges";
import { fetchUsageSummary, type UsageSummarySeries } from "@/lib/usage/summary";
import { meteredFeatures } from "@/scripts/catalog";

import { LiveQuotas } from "./_components/live-quotas";
import { MetricCard } from "./_components/metric-card";
import { RangeTabs } from "./_components/range-tabs";

export const metadata: Metadata = { title: "Usage · Pointer" };

const DEFAULT_RANGE: UsageRangeKey = "24h";

/**
 * A Chargebee outage or an unconfigured site must not take the Redis-backed
 * quotas down with it, so the history section reports its own state.
 */
type History =
  | { status: "ok"; series: UsageSummarySeries[] }
  | { status: "disabled" }
  | { status: "unavailable" };

/** One Chargebee call per metered feature — its summary aggregates one at a time. */
async function loadHistory(
  subscriptionId: string,
  range: UsageRange,
): Promise<History> {
  if (!usageIngestEnabled()) return { status: "disabled" };

  try {
    const series = await Promise.all(
      meteredFeatures.map((feature) =>
        fetchUsageSummary({
          subscriptionId,
          metric: feature.metric,
          window: range.window,
          from: range.from,
          to: range.to,
        }),
      ),
    );
    return { status: "ok", series };
  } catch (error) {
    console.error("[usage] summary lookup failed", error);
    return { status: "unavailable" };
  }
}

export default async function UsagePage({ searchParams }: PageProps<"/usage">) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in?from=/usage");

  const subject = await resolveEntitlementSubject(session, {
    customerType: "user",
  });
  if (!subject) redirect("/choose-plan");

  const { range: requested } = await searchParams;
  const rangeKey =
    typeof requested === "string" && isUsageRange(requested)
      ? requested
      : DEFAULT_RANGE;

  const entitlements = await resolveEntitlements(subject);
  const snapshot = await getUsageSnapshot(subject, entitlements);
  const range = resolveUsageRange(
    rangeKey,
    subject.subscription,
    entitlements.limits,
  );
  const history = await loadHistory(subject.chargebeeSubscriptionId, range);

  return (
    <main className="mx-auto w-full max-w-6xl px-6 pb-16">
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        Usage
      </h1>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        {subject.subscription.planId ?? "No plan"} ·{" "}
        {subject.chargebeeSubscriptionId}
      </p>

      {entitlements.pending ? (
        <p
          role="status"
          className="mt-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        >
          Your plan entitlements are still loading from Chargebee. Free-tier
          limits are shown until they arrive — reload to check again.
        </p>
      ) : null}

      <div className="mt-8">
        <RangeTabs active={range.key} />
      </div>

      <HistorySection history={history} range={range} />

      <div className="mt-8">
        <LiveQuotas snapshot={snapshot} />
      </div>

      <p className="mt-4 text-[11px] leading-5 text-zinc-400">
        Ranges are aggregated by Chargebee from ingested usage events and are
        eventually consistent. Allowances scale the enforced limit to the range,
        so only 24 hours (daily token quotas) and the billing period (monthly
        credits) match a real reset boundary. Enforcement always reads the
        counters under &ldquo;Right now&rdquo;.
      </p>
    </main>
  );
}

function HistorySection({
  history,
  range,
}: {
  history: History;
  range: UsageRange;
}) {
  if (history.status === "disabled") {
    return (
      <Notice>
        Usage tracking is not configured for this environment, so there is no
        history to aggregate. Set{" "}
        <code className="font-mono">CHARGEBEE_USAGE_INGEST_ENABLED=true</code> on
        a site with Advanced Usage Based Billing enabled.
      </Notice>
    );
  }

  if (history.status === "unavailable") {
    return (
      <Notice>
        Usage history is temporarily unavailable. The quotas below come from the
        local counters and are unaffected.
      </Notice>
    );
  }

  return (
    <div className="mt-5 grid gap-4 sm:grid-cols-2">
      {history.series.map((series) => (
        <MetricCard
          key={series.metric}
          title={titleFor(series)}
          series={series}
          range={range}
        />
      ))}
    </div>
  );
}

function titleFor(series: UsageSummarySeries): string {
  const feature = meteredFeatures.find(
    (entry) => entry.metric === series.metric,
  );
  return feature?.name ?? series.metric;
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-5 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
      {children}
    </p>
  );
}
