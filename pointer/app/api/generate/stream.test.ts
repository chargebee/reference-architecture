import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	claimUsageThreshold: vi.fn(),
	emit: vi.fn(),
	getUsageSnapshot: vi.fn(),
	meterGeneration: vi.fn(),
	checkGenerationMidStream: vi.fn(),
	recordUsageEvent: vi.fn(),
	streamGeneration: vi.fn(),
}));

vi.mock("@/lib/entitlements/features", () => ({
	features: {
		creditsMonthly: { featureId: "f_credits_monthly" },
		outputTokensDaily: { featureId: "f_output_tokens_daily" },
	},
}));

vi.mock("@/lib/entitlements/gate", () => ({
	QUOTA_EXHAUSTED: "Quota exhausted",
	getUsageSnapshot: mocks.getUsageSnapshot,
	meterGeneration: mocks.meterGeneration,
	checkGenerationMidStream: mocks.checkGenerationMidStream,
}));

vi.mock("@/lib/events/emit", () => ({ emit: mocks.emit }));
vi.mock("@/lib/generate", () => ({
	estimateTokens: (text: string) => Math.max(1, Math.ceil(text.length / 4)),
	streamGeneration: mocks.streamGeneration,
}));
vi.mock("@/lib/usage/counters", () => ({
	claimUsageThreshold: mocks.claimUsageThreshold,
}));
vi.mock("@/lib/usage/events", () => ({
	recordUsageEvent: mocks.recordUsageEvent,
}));

import {
	type GenerationContext,
	generationResponse,
	MID_STREAM_CHECK_INTERVAL_MS,
} from "./stream";

const snapshot = {
	thresholds: [],
} as Awaited<ReturnType<typeof mocks.getUsageSnapshot>>;

function context(
	overrides: Partial<GenerationContext> = {},
): GenerationContext {
	return {
		subject: {
			chargebeeSubscriptionId: "sub-1",
			subscription: { planId: "plan-pro" },
		},
		entitlements: {
			limits: {},
			pending: false,
		},
		input: {
			prompt: "hello",
			model: "local/lorem-ipsum",
		},
		traceId: "gen-1",
		usageTimestamp: Date.parse("2026-09-28T00:00:00.000Z"),
		outputTokenBudget: 100,
		...overrides,
	} as GenerationContext;
}

describe("generation stream usage enforcement", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.claimUsageThreshold.mockResolvedValue(true);
		mocks.emit.mockResolvedValue(undefined);
		mocks.getUsageSnapshot.mockResolvedValue(snapshot);
		mocks.recordUsageEvent.mockResolvedValue(undefined);
		mocks.checkGenerationMidStream.mockResolvedValue({
			allowed: true,
			thresholds: [],
		});
		mocks.meterGeneration.mockResolvedValue({
			allowed: true,
			creditsConsumed: 0,
			source: "plan_quota",
		});
	});

	it("stops mid-stream before forwarding a delta that exceeds local outputTokenBudget", async () => {
		let streamedTokens = 0;
		let signal: AbortSignal | undefined;
		mocks.streamGeneration.mockImplementation((_input, abortSignal) => {
			signal = abortSignal;
			return {
				deltas: (async function* () {
					streamedTokens = 1;
					yield "first";
					streamedTokens = 2;
					yield "second";
				})(),
				streamedTokens: () => streamedTokens,
				settle: vi.fn().mockResolvedValue({
					output: "firstsecond",
					inputTokens: 2,
					outputTokens: 2,
				}),
			};
		});

		mocks.meterGeneration.mockResolvedValue({
			allowed: false,
			creditsConsumed: 0.004,
			source: "credits",
		});

		// Set budget to 1, so token 2 will trip quotaHit
		const response = generationResponse(context({ outputTokenBudget: 1 }));
		const frames = (await response.text())
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));

		expect(frames).toEqual([
			{ type: "delta", text: "first" },
			expect.objectContaining({ type: "error", error: "quota_exceeded" }),
		]);
		expect(signal?.aborted).toBe(true);
		expect(mocks.meterGeneration).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({
				inputTokens: 2,
				outputTokens: 2,
			}),
		);
		expect(mocks.recordUsageEvent).toHaveBeenCalledOnce();
		expect(mocks.emit).toHaveBeenCalledWith(
			"app.generate_denied",
			expect.objectContaining({ error: "quota_exceeded" }),
			expect.anything(),
		);
	});

	it("aborts mid-stream when 5-second check discovers quota exhausted and emits threshold", async () => {
		let streamedTokens = 0;
		let signal: AbortSignal | undefined;
		mocks.streamGeneration.mockImplementation((_input, abortSignal) => {
			signal = abortSignal;
			return {
				deltas: (async function* () {
					streamedTokens = 10;
					yield "chunk1";
					// Fast forward time to trigger periodic check
					vi.setSystemTime(Date.now() + MID_STREAM_CHECK_INTERVAL_MS + 100);
					streamedTokens = 20;
					yield "chunk2";
				})(),
				streamedTokens: () => streamedTokens,
				settle: vi.fn().mockResolvedValue({
					output: "chunk1chunk2",
					inputTokens: 2,
					outputTokens: 20,
				}),
			};
		});

		vi.useFakeTimers();
		try {
			mocks.checkGenerationMidStream.mockResolvedValue({
				allowed: false,
				thresholds: [{ featureId: "f_output_tokens_daily", percent: 85 }],
			});

			const response = generationResponse(context({ outputTokenBudget: 1000 }));
			const frames = (await response.text())
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));

			expect(frames).toEqual([
				{ type: "delta", text: "chunk1" },
				expect.objectContaining({ type: "error", error: "quota_exceeded" }),
			]);
			expect(signal?.aborted).toBe(true);
			expect(mocks.checkGenerationMidStream).toHaveBeenCalledOnce();
			expect(mocks.recordUsageEvent).toHaveBeenCalledOnce();
			expect(mocks.emit).toHaveBeenCalledWith(
				"app.usage_threshold",
				expect.objectContaining({
					feature_id: "f_output_tokens_daily",
					percent: 85,
				}),
				expect.anything(),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("completes normally when within budget and emits generate_completed", async () => {
		let streamedTokens = 0;
		mocks.streamGeneration.mockImplementation(() => ({
			deltas: (async function* () {
				streamedTokens = 5;
				yield "hello world";
			})(),
			streamedTokens: () => streamedTokens,
			settle: vi.fn().mockResolvedValue({
				output: "hello world",
				inputTokens: 2,
				outputTokens: 5,
			}),
		}));

		const response = generationResponse(context({ outputTokenBudget: 100 }));
		const frames = (await response.text())
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));

		expect(frames).toEqual([
			{ type: "delta", text: "hello world" },
			expect.objectContaining({
				type: "done",
				usage: expect.objectContaining({
					inputTokens: 2,
					outputTokens: 5,
				}),
			}),
		]);
		expect(mocks.recordUsageEvent).toHaveBeenCalledOnce();
		expect(mocks.emit).toHaveBeenCalledWith(
			"app.generate_completed",
			expect.objectContaining({
				input_tokens: 2,
				output_tokens: 5,
			}),
			expect.anything(),
		);
	});
});
