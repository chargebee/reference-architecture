import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
	readUsageCounters: vi.fn(),
	consumeRateLimit: vi.fn(),
	consumeGenerationUsage: vi.fn(),
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
	consumeGenerationUsage: mocks.consumeGenerationUsage,
}));

import type { EntitlementLimits, ResolvedEntitlements } from "./features";
import {
	admitGeneration,
	checkGenerationMidStream,
	EntitlementGateError,
	meterGeneration,
	outputTokenBudget,
} from "./gate";
import type { EntitlementSubject } from "./subject";

const subject = {
	chargebeeSubscriptionId: "sub-1",
	subscription: { planId: "plan-pro", periodEnd: null },
} as unknown as EntitlementSubject;

const MODEL = "local/lorem-ipsum";

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
	rateUsed?: number;
}) {
	const usage = {
		rateUsed: 0,
		inputUsed: 0,
		outputUsed: 0,
		creditsUsed: 0,
		...counters,
	};
	mocks.readUsageCounters.mockResolvedValue({
		...usage,
		dailyResetAt: new Date().toISOString(),
		monthlyResetAt: new Date().toISOString(),
	});
}

describe("pre-flight generation gate and usage enforcement", () => {
	beforeEach(() => {
		mocks.readUsageCounters.mockReset();
		mocks.consumeRateLimit.mockReset();
		mocks.consumeGenerationUsage.mockReset();
		mocks.consumeRateLimit.mockResolvedValue({
			allowed: true,
			used: 1,
			retryAfterSeconds: 0,
		});
		used({});
	});

	it("calculates outputTokenBudget and admits generation when budget > 0", async () => {
		const res = await admitGeneration(subject, plan(), {
			model: MODEL,
			inputTokens: 100,
		});
		expect(res).toMatchObject({
			outputTokenBudget: expect.any(Number),
		});
		expect(res.outputTokenBudget).toBeGreaterThan(0);
	});

	it("denies before the call when nothing is left to spend", async () => {
		used({ outputUsed: 10_000, creditsUsed: 500 });

		await expect(
			admitGeneration(subject, plan(), {
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
			admitGeneration(subject, plan(), {
				model: MODEL,
				inputTokens: 100,
			}),
		).rejects.toMatchObject({
			status: 429,
			code: "rate_limited",
			retryAfterSeconds: 42,
		});
	});

	it("checks usage mid-stream and detects 80% threshold crossings", async () => {
		used({ outputUsed: 7_950 });

		const result = await checkGenerationMidStream(subject, plan(), {
			inputTokens: 100,
			outputTokens: 80,
		});

		expect(result).toMatchObject({
			allowed: true,
			thresholds: [
				{
					featureId: "f_output_tokens_daily",
					percent: 80,
				},
			],
		});
	});

	it("settles produced usage and determines quota vs credits source", async () => {
		mocks.consumeGenerationUsage.mockResolvedValue({
			allowed: true,
			inputUsed: 100,
			outputUsed: 10_001,
			creditsUsed: 0.004,
			creditsConsumed: 0.004,
			overageInputTokens: 0,
			overageOutputTokens: 1,
		});

		const settled = await meterGeneration(subject, plan(), {
			inputTokens: 100,
			outputTokens: 10_001,
		});

		expect(settled).toMatchObject({
			allowed: true,
			creditsConsumed: 0.004,
			source: "credits",
		});
		expect(mocks.consumeGenerationUsage).toHaveBeenCalledWith(
			subject,
			expect.objectContaining({ outputTokensDaily: 10_000 }),
			expect.objectContaining({ inputTokens: 100, outputTokens: 10_001 }),
			undefined,
		);
	});

	it("calculates outputTokenBudget deducting input overage from credits", () => {
		const limits = {
			inputTokensDaily: 100,
			outputTokensDaily: 200,
			creditsMonthly: 1,
			apiRatePerMinute: 60,
			maxSeats: 1,
			sso: false,
			models: "basic" as const,
		};
		// No counters used, inputTokens 100 (within limit):
		// outputAllowance = 200, inputOverage = 0, creditsLeftMilli = 1000
		// budget = 200 + floor(1000 / 4) = 200 + 250 = 450
		expect(
			outputTokenBudget(
				limits,
				{ inputUsed: 0, outputUsed: 0, creditsUsed: 0 },
				100,
			),
		).toBe(450);

		// inputTokens 200 (overage of 100 tokens = 100 milli credits):
		// creditsLeftMilli = 1000 - 100 = 900
		// budget = 200 + floor(900 / 4) = 200 + 225 = 425
		expect(
			outputTokenBudget(
				limits,
				{ inputUsed: 0, outputUsed: 0, creditsUsed: 0 },
				200,
			),
		).toBe(425);
	});
});
