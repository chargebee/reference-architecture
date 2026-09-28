import process from "node:process";
import { afterAll, describe, expect, it } from "vitest";
import type { EntitlementSubject } from "@/lib/entitlements/subject";
import { getRedis } from "@/lib/redis";
import {
	claimUsageThreshold,
	consumeGenerationUsage,
	consumeRateLimit,
	readUsageCounters,
} from "./counters";

const redisTests =
	process.env.RUN_REDIS_TESTS === "1" ? describe : describe.skip;

function subject(id: string): EntitlementSubject {
	return {
		customerType: "user",
		referenceId: `user-${id}`,
		chargebeeCustomerId: `customer-${id}`,
		chargebeeSubscriptionId: id,
		subscription: {
			id: `local-${id}`,
			referenceId: `user-${id}`,
			chargebeeSubscriptionId: id,
			status: "active",
			periodStart: new Date(),
			periodEnd: new Date(Date.now() + 86_400_000),
			seats: 1,
			planQuantity: 1,
			itemPriceId: "plan-pro-USD-Monthly",
			planId: "plan-pro",
			limits: null,
		},
	};
}

redisTests("Redis usage enforcement", () => {
	const suffix = `${process.pid}-${Date.now()}`;

	afterAll(async () => {
		const redis = getRedis();
		const keys = await redis.keys(`usage:*:*${suffix}*`);
		if (keys.length > 0) await redis.del(...keys);
		await redis.quit();
	});

	it("allows exactly the rate limit and denies the next request", async () => {
		const target = subject(`rate-${suffix}`);
		await expect(consumeRateLimit(target, 2)).resolves.toMatchObject({
			allowed: true,
			used: 1,
		});
		await expect(consumeRateLimit(target, 2)).resolves.toMatchObject({
			allowed: true,
			used: 2,
		});
		await expect(consumeRateLimit(target, 2)).resolves.toMatchObject({
			allowed: false,
			used: 3,
		});
	});

	it("resets request aggregation at the next UTC minute", async () => {
		const target = subject(`rate-window-${suffix}`);
		const now = new Date();
		now.setUTCSeconds(50, 0);

		await consumeRateLimit(target, 1, now);
		await expect(consumeRateLimit(target, 1, now)).resolves.toMatchObject({
			allowed: false,
			retryAfterSeconds: 10,
		});
		await expect(
			consumeRateLimit(target, 1, new Date(now.getTime() + 10_000)),
		).resolves.toMatchObject({ allowed: true, used: 1 });
	});

	it("consumes daily quota and spills overage to credits", async () => {
		const credits = subject(`credits-${suffix}`);
		const limits = {
			inputTokensDaily: 1,
			outputTokensDaily: 10,
			creditsMonthly: 1,
		};

		await expect(
			consumeGenerationUsage(credits, limits, {
				inputTokens: 1_001,
				outputTokens: 0,
			}),
		).resolves.toMatchObject({
			allowed: true,
			inputUsed: 1_001,
			creditsConsumed: 1,
			creditsUsed: 1,
		});

		await expect(readUsageCounters(credits)).resolves.toMatchObject({
			inputUsed: 1_001,
			creditsUsed: 1,
		});
	});

	it("denies and records overage when quota and credits are exhausted", async () => {
		const target = subject(`settle-${suffix}`);
		const limits = {
			inputTokensDaily: 2,
			outputTokensDaily: 1,
			creditsMonthly: 0,
		};

		await expect(
			consumeGenerationUsage(target, limits, {
				inputTokens: 1,
				outputTokens: 2,
			}),
		).resolves.toMatchObject({
			allowed: false,
			inputUsed: 0,
			outputUsed: 0,
			creditsConsumed: 0.004,
		});
	});

	it("claims each threshold once per reset window", async () => {
		const target = subject(`threshold-${suffix}`);
		await expect(
			claimUsageThreshold(target, "f_input_tokens_daily"),
		).resolves.toBe(true);
		await expect(
			claimUsageThreshold(target, "f_input_tokens_daily"),
		).resolves.toBe(false);
	});
});
