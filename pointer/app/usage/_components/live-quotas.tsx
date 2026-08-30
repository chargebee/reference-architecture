import type { UsageSnapshot } from "@/lib/entitlements/gate";

import { formatLimit, Meter } from "./meter";

const RESET_FORMAT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
};

function resetLabel(iso: string): string {
  return `${new Date(iso).toLocaleString("en-US", RESET_FORMAT)} UTC`;
}

/**
 * What the gate would decide right now, straight from the Redis counters. This
 * is the enforcement authority — the Chargebee ranges above it are reporting,
 * one flush interval behind.
 */
export function LiveQuotas({ snapshot }: { snapshot: UsageSnapshot }) {
  const { features, period } = snapshot;

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Right now
        </h2>
        <span className="rounded-full bg-violet-100 px-2.5 py-0.5 text-[11px] font-medium text-violet-800 dark:bg-violet-950 dark:text-violet-300">
          {features.models.tier} models
        </span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Meter
          label="Input tokens today"
          used={features.inputTokensDaily.used}
          limit={features.inputTokensDaily.limit}
        />
        <Meter
          label="Output tokens today"
          used={features.outputTokensDaily.used}
          limit={features.outputTokensDaily.limit}
        />
        <Meter
          label="Credits this period"
          used={features.creditsMonthly.used}
          limit={features.creditsMonthly.limit}
        />
        <Meter
          label="Requests this minute"
          used={features.apiRatePerMinute.used}
          limit={features.apiRatePerMinute.limit}
        />
      </div>

      <dl className="mt-5 grid gap-x-6 gap-y-1 text-[11px] text-zinc-500 sm:grid-cols-2 dark:text-zinc-400">
        <div className="flex justify-between gap-3">
          <dt>Token quotas reset</dt>
          <dd className="tabular-nums">{resetLabel(period.dailyTokensResetAt)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Credits reset</dt>
          <dd className="tabular-nums">
            {resetLabel(period.monthlyCreditsResetAt)}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Max seats</dt>
          <dd>{formatLimit(features.maxSeats.limit)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>SSO</dt>
          <dd>{features.sso.enabled ? "Enabled" : "Not included"}</dd>
        </div>
      </dl>
    </section>
  );
}
