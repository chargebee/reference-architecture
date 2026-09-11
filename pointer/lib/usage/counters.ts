import { getRedis } from "@/lib/redis";
import type { EntitlementSubject } from "@/lib/entitlements/subject";

export const INPUT_CREDIT_MILLI_PER_TOKEN = 1;
export const OUTPUT_CREDIT_MILLI_PER_TOKEN = 4;

const RATE_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[2]) end
local ttl = redis.call("PTTL", KEYS[1])
if count > tonumber(ARGV[1]) then return {0, count, ttl} end
return {1, count, ttl}
`;

const CONSUME_SCRIPT = `
local current_input = tonumber(redis.call("GET", KEYS[1]) or "0")
local current_output = tonumber(redis.call("GET", KEYS[2]) or "0")
local current_credits = tonumber(redis.call("GET", KEYS[3]) or "0")
local input_delta = tonumber(ARGV[1])
local output_delta = tonumber(ARGV[2])
local input_limit = tonumber(ARGV[3])
local output_limit = tonumber(ARGV[4])
local credit_limit = tonumber(ARGV[5])

local function overage(current, delta, limit)
  if limit < 0 then return 0 end
  local remaining = math.max(limit - current, 0)
  return math.max(delta - remaining, 0)
end

local over_input = overage(current_input, input_delta, input_limit)
local over_output = overage(current_output, output_delta, output_limit)
local credit_cost = over_input * tonumber(ARGV[6]) +
                    over_output * tonumber(ARGV[7])

if credit_limit >= 0 and current_credits + credit_cost > credit_limit then
  return {0, current_input, current_output, current_credits,
          credit_cost, over_input, over_output}
end

local next_input = redis.call("INCRBY", KEYS[1], input_delta)
local next_output = redis.call("INCRBY", KEYS[2], output_delta)
local next_credits = redis.call("INCRBY", KEYS[3], credit_cost)
redis.call("EXPIREAT", KEYS[1], ARGV[8])
redis.call("EXPIREAT", KEYS[2], ARGV[8])
redis.call("EXPIREAT", KEYS[3], ARGV[9])
return {1, next_input, next_output, next_credits,
        credit_cost, over_input, over_output}
`;

function compactUtc(date: Date): string {
	return date.toISOString().slice(0, 16).replace(/\D/g, "");
}

function nextUtcMidnight(now = new Date()): Date {
	return new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
	);
}

function nextMonthlyReset(subject: EntitlementSubject, now = new Date()): Date {
	const periodEnd = subject.subscription.periodEnd;
	if (periodEnd && periodEnd.getTime() > now.getTime()) return periodEnd;
	return new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()),
	);
}

function usageKeys(subject: EntitlementSubject, now = new Date()) {
	const subscriptionId = encodeURIComponent(subject.chargebeeSubscriptionId);
	const daily = now.toISOString().slice(0, 10);
	const reset = nextMonthlyReset(subject, now);
	return {
		rate: `usage:rate:${subscriptionId}:${compactUtc(now)}`,
		input: `usage:quota:${subscriptionId}:input:${daily}`,
		output: `usage:quota:${subscriptionId}:output:${daily}`,
		credits: `usage:credits:${subscriptionId}:${reset.toISOString()}`,
		dailyReset: nextUtcMidnight(now),
		monthlyReset: reset,
	};
}

function finiteLimit(limit: number): number {
	return Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : -1;
}

function numbers(result: unknown): number[] {
	if (!Array.isArray(result)) throw new Error("Unexpected Redis script result");
	return result.map(Number);
}

export type RateLimitResult = {
	allowed: boolean;
	used: number;
	retryAfterSeconds: number;
};

export async function consumeRateLimit(
	subject: EntitlementSubject,
	limit: number,
	now = new Date(),
): Promise<RateLimitResult> {
	if (!Number.isFinite(limit)) {
		return { allowed: true, used: 0, retryAfterSeconds: 0 };
	}
	const key = usageKeys(subject, now).rate;
	const [allowed, used, ttlMs] = numbers(
		await getRedis().eval(RATE_SCRIPT, 1, key, finiteLimit(limit), 90_000),
	);
	return {
		allowed: allowed === 1,
		used: used ?? 0,
		retryAfterSeconds: Math.max(1, Math.ceil((ttlMs ?? 60_000) / 1_000)),
	};
}

export type GenerationUsageResult = {
	allowed: boolean;
	inputUsed: number;
	outputUsed: number;
	creditsUsed: number;
	creditsConsumed: number;
	overageInputTokens: number;
	overageOutputTokens: number;
};

export async function consumeGenerationUsage(
	subject: EntitlementSubject,
	limits: {
		inputTokensDaily: number;
		outputTokensDaily: number;
		creditsMonthly: number;
	},
	usage: { inputTokens: number; outputTokens: number },
	now = new Date(),
): Promise<GenerationUsageResult> {
	const keys = usageKeys(subject, now);
	const creditLimitMilli = Number.isFinite(limits.creditsMonthly)
		? Math.floor(limits.creditsMonthly * 1_000)
		: -1;
	const [
		allowed,
		inputUsed,
		outputUsed,
		creditsUsedMilli,
		creditCostMilli,
		overageInputTokens,
		overageOutputTokens,
	] = numbers(
		await getRedis().eval(
			CONSUME_SCRIPT,
			3,
			keys.input,
			keys.output,
			keys.credits,
			Math.max(0, Math.floor(usage.inputTokens)),
			Math.max(0, Math.floor(usage.outputTokens)),
			finiteLimit(limits.inputTokensDaily),
			finiteLimit(limits.outputTokensDaily),
			creditLimitMilli,
			INPUT_CREDIT_MILLI_PER_TOKEN,
			OUTPUT_CREDIT_MILLI_PER_TOKEN,
			Math.floor(keys.dailyReset.getTime() / 1_000),
			Math.floor(keys.monthlyReset.getTime() / 1_000),
		),
	);
	return {
		allowed: allowed === 1,
		inputUsed: inputUsed ?? 0,
		outputUsed: outputUsed ?? 0,
		creditsUsed: (creditsUsedMilli ?? 0) / 1_000,
		creditsConsumed: (creditCostMilli ?? 0) / 1_000,
		overageInputTokens: overageInputTokens ?? 0,
		overageOutputTokens: overageOutputTokens ?? 0,
	};
}

export async function readUsageCounters(
	subject: EntitlementSubject,
	now = new Date(),
) {
	const keys = usageKeys(subject, now);
	const values = await getRedis().mget(
		keys.rate,
		keys.input,
		keys.output,
		keys.credits,
	);
	return {
		rateUsed: Number(values[0] ?? 0),
		inputUsed: Number(values[1] ?? 0),
		outputUsed: Number(values[2] ?? 0),
		creditsUsed: Number(values[3] ?? 0) / 1_000,
		dailyResetAt: keys.dailyReset.toISOString(),
		monthlyResetAt: keys.monthlyReset.toISOString(),
	};
}

export async function claimUsageThreshold(
	subject: EntitlementSubject,
	featureId: string,
	now = new Date(),
): Promise<boolean> {
	const keys = usageKeys(subject, now);
	let period: string;
	let ttlMs: number;
	if (featureId === "f_api_rate_per_minute") {
		period = compactUtc(now);
		ttlMs = 90_000;
	} else if (featureId === "f_credits_monthly") {
		period = keys.monthlyReset.toISOString();
		ttlMs = Math.max(1_000, keys.monthlyReset.getTime() - now.getTime());
	} else {
		period = now.toISOString().slice(0, 10);
		ttlMs = Math.max(1_000, keys.dailyReset.getTime() - now.getTime());
	}
	const subscriptionId = encodeURIComponent(subject.chargebeeSubscriptionId);
	const key = `usage:threshold:${subscriptionId}:${featureId}:${period}`;
	return (await getRedis().set(key, "1", "PX", ttlMs, "NX")) === "OK";
}
