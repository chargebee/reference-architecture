import { describe, expect, it } from "vitest";

import { isUsageRange, resolveUsageRange } from "./ranges";

/** Wednesday, 29 July 2026 at 14:20:33 UTC. */
const NOW = new Date("2026-07-29T14:20:33.000Z");

const LIMITS = {
	inputTokensDaily: 50_000,
	outputTokensDaily: 10_000,
	creditsMonthly: 300,
};

/** A 31-day period, two thirds elapsed at NOW. */
const PERIOD = {
	periodStart: new Date("2026-07-09T00:00:00.000Z"),
	periodEnd: new Date("2026-08-09T00:00:00.000Z"),
};

const NO_PERIOD = { periodStart: null, periodEnd: null };

describe("isUsageRange", () => {
	it("rejects a range the page does not declare", () => {
		expect(isUsageRange("7d")).toBe(true);
		expect(isUsageRange("90d")).toBe(false);
	});
});

describe("resolveUsageRange", () => {
	it("buckets the last 24 hours hourly", () => {
		const range = resolveUsageRange("24h", PERIOD, LIMITS, NOW);

		expect(range.window).toBe("hour");
		expect(range.from.toISOString()).toBe("2026-07-28T14:20:33.000Z");
		expect(range.to).toBe(NOW);
	});

	it("buckets the longer ranges daily", () => {
		expect(resolveUsageRange("7d", PERIOD, LIMITS, NOW).window).toBe("day");
		expect(
			resolveUsageRange("30d", PERIOD, LIMITS, NOW).from.toISOString(),
		).toBe("2026-06-29T14:20:33.000Z");
	});

	it("starts the billing period range at the period start", () => {
		const range = resolveUsageRange("period", PERIOD, LIMITS, NOW);

		expect(range.from).toBe(PERIOD.periodStart);
		expect(range.to).toBe(NOW);
	});

	it("falls back to 30 days when the mirror has no period start", () => {
		const range = resolveUsageRange("period", NO_PERIOD, LIMITS, NOW);

		expect(range.from.toISOString()).toBe("2026-06-29T14:20:33.000Z");
	});

	it("falls back when the period has not started yet", () => {
		const future = {
			periodStart: new Date("2026-08-09T00:00:00.000Z"),
			periodEnd: new Date("2026-09-09T00:00:00.000Z"),
		};

		const range = resolveUsageRange("period", future, LIMITS, NOW);

		expect(range.from.toISOString()).toBe("2026-06-29T14:20:33.000Z");
	});

	it("reads a 24h range against the untouched daily quotas", () => {
		const { allowances } = resolveUsageRange("24h", PERIOD, LIMITS, NOW);

		expect(allowances.input_tokens).toBe(50_000);
		expect(allowances.output_tokens).toBe(10_000);
	});

	it("scales the daily quotas across a multi-day range", () => {
		const { allowances } = resolveUsageRange("7d", PERIOD, LIMITS, NOW);

		expect(allowances.input_tokens).toBe(350_000);
	});

	it("prorates monthly credits by the fraction of the period covered", () => {
		// 7 of the period's 31 days.
		const { allowances } = resolveUsageRange("7d", PERIOD, LIMITS, NOW);

		expect(allowances.credits_consumed).toBe(Math.round((300 * 7) / 31));
	});

	it("grants the whole credit allowance over the full period", () => {
		const wholePeriod = {
			periodStart: PERIOD.periodStart,
			periodEnd: new Date("2026-07-29T14:20:33.000Z"),
		};

		const { allowances } = resolveUsageRange(
			"period",
			wholePeriod,
			LIMITS,
			NOW,
		);

		expect(allowances.credits_consumed).toBe(300);
	});

	it("keeps an unlimited entitlement unlimited at any scale", () => {
		const { allowances } = resolveUsageRange(
			"30d",
			PERIOD,
			{ ...LIMITS, creditsMonthly: Number.POSITIVE_INFINITY },
			NOW,
		);

		expect(allowances.credits_consumed).toBe(Number.POSITIVE_INFINITY);
	});

	it("leaves generations unbounded — no entitlement governs it", () => {
		const { allowances } = resolveUsageRange("30d", PERIOD, LIMITS, NOW);

		expect(allowances.generations).toBeNull();
	});
});
