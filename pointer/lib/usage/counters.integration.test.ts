import { afterAll, describe, expect, it } from "vitest";

import { getRedis } from "@/lib/redis";
import type { EntitlementSubject } from "@/lib/entitlements/subject";

import {
	claimUsageThreshold,
	consumeGenerationUsage,
	consumeRateLimit,
	readUsageCounters,
} from "./counters";
import process from "node:process";

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

	it("rolls back denied token usage and spends only incremental overage", async () => {
		const hardCap = subject(`hard-${suffix}`);
		await expect(
			consumeGenerationUsage(
				hardCap,
				{
					inputTokensDaily: 5,
					outputTokensDaily: 5,
					creditsMonthly: 0,
				},
				{ inputTokens: 5, outputTokens: 5 },
			),
		).resolves.toMatchObject({ allowed: true, inputUsed: 5, outputUsed: 5 });
		await expect(
			consumeGenerationUsage(
				hardCap,
				{
					inputTokensDaily: 5,
					outputTokensDaily: 5,
					creditsMonthly: 0,
				},
				{ inputTokens: 1, outputTokens: 1 },
			),
		).resolves.toMatchObject({ allowed: false, inputUsed: 5, outputUsed: 5 });

		const credits = subject(`credits-${suffix}`);
		await expect(
			consumeGenerationUsage(
				credits,
				{
					inputTokensDaily: 1,
					outputTokensDaily: 10,
					creditsMonthly: 1,
				},
				{ inputTokens: 1_001, outputTokens: 0 },
			),
		).resolves.toMatchObject({
			allowed: true,
			creditsConsumed: 1,
			overageInputTokens: 1_000,
		});
		await expect(readUsageCounters(credits)).resolves.toMatchObject({
			inputUsed: 1_001,
			creditsUsed: 1,
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
