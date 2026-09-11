/**
 * Buffered usage read back as a time series, from the local archive.
 *
 * This is a reporting surface, never an enforcement one. Events land here a
 * batch behind the flush interval, so quota decisions stay with the Redis
 * counters in `counters.ts`. What this gives the subscriber is history, which
 * the counters cannot: they only ever hold the current period.
 *
 * # Why not Chargebee's usage summary
 *
 * Chargebee is still the billing system of record and still receives every
 * event, but its API quota is a billing budget. A subscriber refreshing this
 * page several times a day would spend it on reporting. `store.ts` aggregates
 * the same events out of Postgres instead, at no external cost.
 *
 * # Window alignment
 *
 * A chart labelled "daily" has to mean calendar days, so the requested start is
 * snapped to a UTC boundary and every bucket in the range is emitted — an empty
 * one as zero. `GROUP BY` only returns occupied buckets, and the chart spaces
 * points evenly, so a sparse series would silently misdate every bar.
 */

import { meteredFeatureFor, type UsageMetric } from "@/scripts/catalog";

import { readUsageSeries, type UsageBucket } from "./store";

export type UsageWindow = "hour" | "day" | "week" | "month";

const WINDOWS: UsageWindow[] = ["hour", "day", "week", "month"];

/** Bounds the response on an over-broad range, e.g. hourly windows across a year. */
const MAX_WINDOWS = 1_000;

export function isUsageWindow(value: string): value is UsageWindow {
	return (WINDOWS as string[]).includes(value);
}

/**
 * Floors a timestamp to the start of its UTC calendar window. Weeks start
 * Monday, matching ISO-8601 and the weekly partition boundaries.
 */
export function snapToWindow(date: Date, window: UsageWindow): Date {
	const year = date.getUTCFullYear();
	const month = date.getUTCMonth();
	const day = date.getUTCDate();

	if (window === "hour") {
		return new Date(Date.UTC(year, month, day, date.getUTCHours()));
	}
	if (window === "day") {
		return new Date(Date.UTC(year, month, day));
	}
	if (window === "week") {
		// getUTCDay() is 0 for Sunday; rotate so Monday is 0.
		const offset = (date.getUTCDay() + 6) % 7;
		return new Date(Date.UTC(year, month, day - offset));
	}
	return new Date(Date.UTC(year, month, 1));
}

/** Start of the window after `date`. `date` is assumed already snapped. */
function nextWindow(date: Date, window: UsageWindow): Date {
	const year = date.getUTCFullYear();
	const month = date.getUTCMonth();
	const day = date.getUTCDate();

	if (window === "hour") {
		return new Date(Date.UTC(year, month, day, date.getUTCHours() + 1));
	}
	if (window === "day") {
		return new Date(Date.UTC(year, month, day + 1));
	}
	if (window === "week") {
		return new Date(Date.UTC(year, month, day + 7));
	}
	return new Date(Date.UTC(year, month + 1, 1));
}

export type UsageSummaryPoint = {
	/** Inclusive start of the bucket. */
	from: string;
	/** Exclusive end of the bucket. */
	to: string;
	value: number;
};

export type UsageSummarySeries = {
	metric: UsageMetric;
	featureId: string;
	unit: string;
	window: UsageWindow;
	from: string;
	to: string;
	points: UsageSummaryPoint[];
	/** True when the range held more buckets than one response may carry. */
	truncated: boolean;
};

export type UsageSummaryQuery = {
	subscriptionId: string;
	metric: UsageMetric;
	window: UsageWindow;
	from: Date;
	to: Date;
};

/** Walks the range one window at a time, reading zero where nothing was recorded. */
function fillBuckets(
	buckets: UsageBucket[],
	window: UsageWindow,
	from: Date,
	to: Date,
): { points: UsageSummaryPoint[]; truncated: boolean } {
	const recorded = new Map(
		buckets.map((bucket) => [bucket.from.getTime(), bucket.value]),
	);

	const points: UsageSummaryPoint[] = [];
	let start = from;

	while (start < to) {
		if (points.length >= MAX_WINDOWS) return { points, truncated: true };

		const end = nextWindow(start, window);
		points.push({
			from: start.toISOString(),
			to: end.toISOString(),
			value: recorded.get(start.getTime()) ?? 0,
		});
		start = end;
	}

	return { points, truncated: false };
}

export async function fetchUsageSummary(
	query: UsageSummaryQuery,
): Promise<UsageSummarySeries> {
	const feature = meteredFeatureFor(query.metric);
	const from = snapToWindow(query.from, query.window);

	const buckets = await readUsageSeries({
		subscriptionId: query.subscriptionId,
		metric: query.metric,
		window: query.window,
		from,
		to: query.to,
		// One past the cap: enough to know the range overflowed without paging it.
		limit: MAX_WINDOWS + 1,
	});

	const { points, truncated } = fillBuckets(
		buckets,
		query.window,
		from,
		query.to,
	);

	return {
		metric: query.metric,
		featureId: feature.expectedId,
		unit: feature.feature_unit,
		window: query.window,
		from: from.toISOString(),
		to: query.to.toISOString(),
		points,
		truncated,
	};
}
