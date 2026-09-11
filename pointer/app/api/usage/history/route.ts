import type { NextRequest } from "next/server";

import { auth } from "@/lib/auth";
import { resolveEntitlementSubject } from "@/lib/entitlements/subject";
import { usageIngestEnabled } from "@/lib/usage/events";
import {
	fetchUsageSummary,
	isUsageWindow,
	type UsageWindow,
} from "@/lib/usage/summary";
import { meteredFeatures, type UsageMetric } from "@/scripts/catalog";

/**
 * Historical usage for the signed-in subscriber, bucketed by time.
 *
 * Sibling of `../route.ts`, which answers "where am I against my limits right
 * now" from the Redis counters. This one answers "what did I use over time",
 * which the counters cannot, because they reset each period. It reads the
 * archive in Postgres, not Chargebee — see `lib/usage/summary.ts`.
 *
 * One metric per request, mirroring the metered features one-for-one, so a
 * two-series chart is two requests.
 */

const DEFAULT_WINDOW: UsageWindow = "day";
const DEFAULT_RANGE_DAYS = 30;

function isMetric(value: string): value is UsageMetric {
	return meteredFeatures.some((spec) => spec.metric === value);
}

class QueryError extends Error {}

function parseInstant(value: string | null, fallback: Date): Date {
	if (!value) return fallback;

	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		throw new QueryError(`Not a valid ISO-8601 timestamp: ${value}`);
	}
	return parsed;
}

function parseQuery(request: NextRequest) {
	const params = request.nextUrl.searchParams;

	const metric = params.get("metric") ?? "";
	if (!isMetric(metric)) {
		throw new QueryError(
			`Unknown metric "${metric}". Expected one of: ${meteredFeatures
				.map((spec) => spec.metric)
				.join(", ")}`,
		);
	}

	const window = params.get("window") ?? DEFAULT_WINDOW;
	if (!isUsageWindow(window)) {
		throw new QueryError(`Unknown window "${window}"`);
	}

	const to = parseInstant(params.get("to"), new Date());
	const from = parseInstant(
		params.get("from"),
		new Date(to.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1_000),
	);
	if (from >= to) {
		throw new QueryError("`from` must be earlier than `to`");
	}

	return { metric, window, from, to };
}

export async function GET(request: NextRequest): Promise<Response> {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session) {
		return Response.json(
			{ error: "unauthenticated", message: "Sign in to view usage" },
			{ status: 401 },
		);
	}

	if (!usageIngestEnabled()) {
		return Response.json(
			{
				error: "usage_tracking_disabled",
				message: "Usage tracking is not configured for this environment",
			},
			{ status: 503 },
		);
	}

	let query;
	try {
		query = parseQuery(request);
	} catch (error) {
		if (!(error instanceof QueryError)) throw error;
		return Response.json(
			{ error: "invalid_request", message: error.message },
			{ status: 400 },
		);
	}

	const subject = await resolveEntitlementSubject(session, {
		customerType: "user",
	});
	if (!subject) {
		return Response.json(
			{
				error: "no_subscription",
				message: "Choose a plan to view usage",
				upgradeHint: { action: "upgrade", href: "/choose-plan" },
			},
			{ status: 403 },
		);
	}

	try {
		const series = await fetchUsageSummary({
			subscriptionId: subject.chargebeeSubscriptionId,
			...query,
		});
		return Response.json(series);
	} catch (error) {
		console.error("[usage-history] summary lookup failed", error);
		return Response.json(
			{
				error: "usage_history_unavailable",
				message: "Usage history is temporarily unavailable",
			},
			{ status: 503 },
		);
	}
}
