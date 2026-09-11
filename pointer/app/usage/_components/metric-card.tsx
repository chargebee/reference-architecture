import type { UsageRange } from "@/lib/usage/ranges";
import type {
	UsageSummaryPoint,
	UsageSummarySeries,
	UsageWindow,
} from "@/lib/usage/summary";

import { Meter } from "./meter";

/** Keeps a zero bucket visible as a baseline rather than nothing at all. */
const MIN_BAR_PERCENT = 2;

/** Hourly buckets carry the date too: a 24h range crosses midnight. */
const BUCKET_FORMATS: Record<UsageWindow, Intl.DateTimeFormatOptions> = {
	hour: { month: "short", day: "numeric", hour: "numeric", timeZone: "UTC" },
	day: { month: "short", day: "numeric", timeZone: "UTC" },
	week: { month: "short", day: "numeric", timeZone: "UTC" },
	month: { month: "short", year: "numeric", timeZone: "UTC" },
};

/** Buckets are UTC-aligned, so labelling them in local time would misname them. */
function bucketLabel(point: UsageSummaryPoint, window: UsageWindow): string {
	return new Date(point.from).toLocaleString("en-US", BUCKET_FORMATS[window]);
}

function Bars({
	points,
	window,
	unit,
}: {
	points: UsageSummaryPoint[];
	window: UsageWindow;
	unit: string;
}) {
	const peak = Math.max(...points.map((point) => point.value), 1);

	return (
		<>
			<div className="mt-4 flex h-20 items-end gap-[2px]">
				{points.map((point) => (
					<div
						key={point.from}
						title={`${bucketLabel(point, window)} UTC — ${point.value.toLocaleString()} ${unit}`}
						className="min-h-[1px] flex-1 rounded-t-sm bg-[#6E56CF]/70 transition-colors hover:bg-[#6E56CF]"
						style={{
							height: `${Math.max(MIN_BAR_PERCENT, (point.value / peak) * 100)}%`,
						}}
					/>
				))}
			</div>
			<div className="mt-1.5 flex justify-between text-[10px] tabular-nums text-zinc-400">
				<span>{bucketLabel(points[0], window)}</span>
				<span>{bucketLabel(points[points.length - 1], window)}</span>
			</div>
		</>
	);
}

function Note({ children }: { children: React.ReactNode }) {
	return <p className="mt-3 text-[11px] text-zinc-400">{children}</p>;
}

function Allowance({
	total,
	allowance,
	rangeLabel,
}: {
	total: number;
	allowance: number | null;
	rangeLabel: string;
}) {
	if (allowance === null) return <Note>No entitlement caps this metric</Note>;

	// A scaled-to-zero allowance is a feature the plan does not grant at all,
	// which a "0 / 0" meter would read as a bug rather than an upsell.
	if (allowance === 0) return <Note>Not included on this plan</Note>;

	return (
		<div className="mt-3">
			<Meter
				label={`${rangeLabel} allowance`}
				used={total}
				limit={Number.isFinite(allowance) ? allowance : "unlimited"}
			/>
		</div>
	);
}

export function MetricCard({
	title,
	series,
	range,
}: {
	title: string;
	series: UsageSummarySeries;
	range: UsageRange;
}) {
	const total = series.points.reduce((sum, point) => sum + point.value, 0);

	return (
		<section className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
			<div className="flex items-baseline justify-between gap-3">
				<h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
					{title}
				</h3>
				<span className="text-[11px] uppercase tracking-wide text-zinc-400">
					{series.unit}
				</span>
			</div>

			<p className="mt-2 text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
				{total.toLocaleString()}
			</p>

			<Allowance
				total={total}
				allowance={range.allowances[series.metric]}
				rangeLabel={range.label}
			/>

			{series.points.length > 0 ? (
				<Bars
					points={series.points}
					window={series.window}
					unit={series.unit}
				/>
			) : (
				<p className="mt-4 text-xs text-zinc-400">
					Nothing recorded in this range.
				</p>
			)}

			{series.truncated ? (
				<p className="mt-2 text-[10px] text-amber-600 dark:text-amber-500">
					Range trimmed — too many buckets to chart.
				</p>
			) : null}
		</section>
	);
}
