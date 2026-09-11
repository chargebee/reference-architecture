import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
	readUsageCounters: vi.fn(),
	consumeRateLimit: vi.fn(),
}));

// The catalog binds every feature to the client at import time, so the gate
// cannot load without one.
vi.mock("./provider", async () => {
	const { Feature } = await import("@chargebee/entitlements");
	const client = { getValue: vi.fn() };
	return {
		entitlements: {
			feature: <T>(featureId: string, defaultValue: T) =>
				new Feature<T>(featureId, defaultValue, client),
		},
	};
});

vi.mock("@/lib/usage/counters", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/usage/counters")>()),
	readUsageCounters: mocks.readUsageCounters,
	consumeRateLimit: mocks.consumeRateLimit,
}));

import type { EntitlementLimits, ResolvedEntitlements } from "./features";
import { EntitlementGateError, admitGeneration } from "./gate";
import type { EntitlementSubject } from "./subject";

const subject = {
	chargebeeSubscriptionId: "sub-1",
	subscription: { planId: "plan-pro", periodEnd: null },
} as unknown as EntitlementSubject;

const MODEL = "openai/gpt-4o-mini";

function plan(
	overrides: Partial<EntitlementLimits> = {},
): ResolvedEntitlements {
	return {
		limits: {
			inputTokensDaily: 50_000,
			outputTokensDaily: 10_000,
			creditsMonthly: 500,
			apiRatePerMinute: 30,
			maxSeats: 1,
			sso: false,
			models: "basic",
			...overrides,
		},
		pending: false,
	};
}

function used(counters: {
	inputUsed?: number;
	outputUsed?: number;
	creditsUsed?: number;
}) {
	mocks.readUsageCounters.mockResolvedValue({
		rateUsed: 0,
		inputUsed: 0,
		outputUsed: 0,
		creditsUsed: 0,
		dailyResetAt: new Date().toISOString(),
		monthlyResetAt: new Date().toISOString(),
		...counters,
	});
}

describe("pre-flight generation gate", () => {
	beforeEach(() => {
		mocks.readUsageCounters.mockReset();
		mocks.consumeRateLimit.mockReset();
		mocks.consumeRateLimit.mockResolvedValue({
			allowed: true,
			used: 1,
			retryAfterSeconds: 0,
		});
	});

	it("budgets the daily allowance plus what credits can buy", async () => {
		used({});

		// 10,000 output tokens left, and 500 credits at 4 milli-credits each.
		await expect(
			admitGeneration(subject, plan(), { model: MODEL, inputTokens: 100 }),
		).resolves.toEqual({ outputTokenBudget: 10_000 + 125_000 });
	});

	it("charges the input overage against the same credits", async () => {
		used({ inputUsed: 50_000, outputUsed: 10_000 });

		// Nothing left daily, and 100 input tokens eat 100 milli-credits first.
		await expect(
			admitGeneration(subject, plan(), { model: MODEL, inputTokens: 100 }),
		).resolves.toEqual({ outputTokenBudget: (500_000 - 100) / 4 });
	});

	it("treats an unlimited allowance as an unlimited budget", async () => {
		used({ creditsUsed: 500 });

		await expect(
			admitGeneration(
				subject,
				plan({ outputTokensDaily: Number.POSITIVE_INFINITY }),
				{ model: MODEL, inputTokens: 100 },
			),
		).resolves.toEqual({ outputTokenBudget: Number.POSITIVE_INFINITY });
	});

	it("denies before the call when nothing is left to spend", async () => {
		used({ outputUsed: 10_000 });

		await expect(
			admitGeneration(subject, plan({ creditsMonthly: 0 }), {
				model: MODEL,
				inputTokens: 100,
			}),
		).rejects.toMatchObject({ status: 402, code: "quota_exceeded" });
	});

	it("rejects a model the tier does not grant before reading usage", async () => {
		await expect(
			admitGeneration(subject, plan(), {
				model: "openai/gpt-5-pro",
				inputTokens: 100,
			}),
		).rejects.toBeInstanceOf(EntitlementGateError);
		expect(mocks.readUsageCounters).not.toHaveBeenCalled();
	});

	it("surfaces the retry delay when the rate limit is spent", async () => {
		mocks.consumeRateLimit.mockResolvedValue({
			allowed: false,
			used: 31,
			retryAfterSeconds: 42,
		});

		await expect(
			admitGeneration(subject, plan(), { model: MODEL, inputTokens: 100 }),
		).rejects.toMatchObject({
			status: 429,
			code: "rate_limited",
			retryAfterSeconds: 42,
		});
	});
});
