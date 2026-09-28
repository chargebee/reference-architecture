import {
	features,
	type ResolvedEntitlements,
} from "@/lib/entitlements/features";
import {
	checkGenerationMidStream,
	getUsageSnapshot,
	meterGeneration,
	QUOTA_EXHAUSTED,
	type UsageThreshold,
} from "@/lib/entitlements/gate";
import type { EntitlementSubject } from "@/lib/entitlements/subject";
import { emit } from "@/lib/events/emit";
import {
	estimateTokens,
	type GenerateInput,
	type Generation,
	streamGeneration,
} from "@/lib/generate";
import { claimUsageThreshold } from "@/lib/usage/counters";
import { recordUsageEvent } from "@/lib/usage/events";

import {
	encodeFrame,
	type GenerateFrame,
	NDJSON_CONTENT_TYPE,
	upgradeHint,
} from "./frames";

export const MID_STREAM_CHECK_INTERVAL_MS = 5_000;

const STREAM_HEADERS = {
	"content-type": NDJSON_CONTENT_TYPE,
	"cache-control": "no-cache, no-transform",
	// Without this an nginx-style proxy buffers the whole body and the client
	// gets one burst at the end instead of a stream.
	"x-accel-buffering": "no",
};

const UPSTREAM_UNAVAILABLE = "The model provider is temporarily unavailable";

export type GenerationContext = {
	subject: EntitlementSubject;
	entitlements: ResolvedEntitlements;
	input: GenerateInput;
	traceId: string;
	usageTimestamp: number;
	outputTokenBudget?: number;
};

type Write = (frame: GenerateFrame) => void;

async function alertThresholds(
	context: GenerationContext,
	thresholds: UsageThreshold[],
	alerted: Set<string>,
): Promise<void> {
	const fresh = thresholds.filter((crossed) => {
		if (alerted.has(crossed.featureId)) {
			return false;
		}
		alerted.add(crossed.featureId);
		return true;
	});

	await Promise.all(
		fresh.map(async (crossed) => {
			try {
				if (
					!(await claimUsageThreshold(
						context.subject,
						crossed.featureId,
						new Date(context.usageTimestamp),
					))
				) {
					return;
				}
				await emit(
					"app.usage_threshold",
					{
						subscription_id: context.subject.chargebeeSubscriptionId,
						feature_id: crossed.featureId,
						percent: crossed.percent,
					},
					{ source: "app", trace_id: context.traceId },
				);
			} catch (error) {
				// Alert delivery must not interrupt a paid generation.
				console.error("[usage] failed to publish local threshold", error);
			}
		}),
	);
}

async function finishUsage(
	context: GenerationContext,
	usage: Generation,
	alerted: Set<string>,
) {
	const { subject, entitlements, input, traceId, usageTimestamp } = context;
	const consumed = await meterGeneration(subject, entitlements, {
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		at: new Date(usageTimestamp),
	});

	// Buffer billable usage before optional snapshot and alert work.
	await recordUsageEvent({
		deduplicationId: traceId,
		subscriptionId: subject.chargebeeSubscriptionId,
		usageTimestamp,
		properties: {
			generation_id: traceId,
			model: input.model,
			input_tokens: usage.inputTokens,
			output_tokens: usage.outputTokens,
			credits_consumed: consumed.creditsConsumed,
			usage_source: consumed.source,
			plan_id: subject.subscription.planId ?? "unknown",
		},
	});

	const limits = await getUsageSnapshot(subject, entitlements);
	await alertThresholds(context, limits.thresholds, alerted);

	return { consumed, limits };
}

async function forwardDeltas(options: {
	context: GenerationContext;
	generation: ReturnType<typeof streamGeneration>;
	abort: AbortController;
	alerted: Set<string>;
	write: Write;
}): Promise<{ quotaHit: boolean; failure?: unknown }> {
	const { context, generation, abort, alerted, write } = options;
	const { subject, entitlements, input, usageTimestamp, outputTokenBudget } =
		context;
	const inputTokens = estimateTokens(input.prompt);

	let lastCheck = Date.now();
	let quotaHit = false;

	try {
		for await (const text of generation.deltas) {
			const outputTokens = generation.streamedTokens();

			// 1. Fast local check against outputTokenBudget calculated at admission.
			if (outputTokenBudget !== undefined && outputTokens > outputTokenBudget) {
				abort.abort();
				quotaHit = true;
				break;
			}

			// 2. Periodic mid-stream check (every 5 seconds) to catch concurrent usage or threshold crossing.
			const now = Date.now();
			if (now - lastCheck >= MID_STREAM_CHECK_INTERVAL_MS) {
				lastCheck = now;
				const progress = await checkGenerationMidStream(subject, entitlements, {
					inputTokens,
					outputTokens,
					at: new Date(usageTimestamp),
				});
				await alertThresholds(context, progress.thresholds, alerted);

				if (!progress.allowed) {
					abort.abort();
					quotaHit = true;
					break;
				}
			}

			write({ type: "delta", text });
		}
	} catch (error) {
		abort.abort();
		return { quotaHit, failure: error };
	}

	return { quotaHit };
}

async function denyQuota(
	context: GenerationContext,
	limits: Awaited<ReturnType<typeof getUsageSnapshot>>,
	write: Write,
): Promise<void> {
	write({
		type: "error",
		error: "quota_exceeded",
		message: QUOTA_EXHAUSTED,
		featureId: features.creditsMonthly.featureId,
		upgradeHint: upgradeHint("buy_credits"),
		limits,
	});
	await emit(
		"app.generate_denied",
		{
			subscription_id: context.subject.chargebeeSubscriptionId,
			model: context.input.model,
			error: "quota_exceeded",
			feature_id: features.creditsMonthly.featureId,
		},
		{ source: "app", trace_id: context.traceId },
	);
}

async function completeGeneration(options: {
	context: GenerationContext;
	settled: Generation;
	finished: Awaited<ReturnType<typeof finishUsage>>;
	write: Write;
}): Promise<void> {
	const { context, settled, finished, write } = options;
	const { input, traceId, subject } = context;
	const { consumed, limits } = finished;

	write({
		type: "done",
		id: traceId,
		model: input.model,
		usage: {
			inputTokens: settled.inputTokens,
			outputTokens: settled.outputTokens,
			creditsConsumed: consumed.creditsConsumed,
			source: consumed.source,
		},
		limits,
	});

	await emit(
		"app.generate_completed",
		{
			subscription_id: subject.chargebeeSubscriptionId,
			model: input.model,
			input_tokens: settled.inputTokens,
			output_tokens: settled.outputTokens,
			credits_consumed: consumed.creditsConsumed,
			usage_source: consumed.source,
		},
		{ source: "app", trace_id: traceId },
	);
}

async function pump(context: GenerationContext, write: Write): Promise<void> {
	const abort = new AbortController();
	const alerted = new Set<string>();
	let generation: ReturnType<typeof streamGeneration>;

	try {
		generation = streamGeneration(context.input, abort.signal);
	} catch (error) {
		await finishUsage(
			context,
			{
				output: "",
				inputTokens: estimateTokens(context.input.prompt),
				outputTokens: 0,
			},
			alerted,
		);
		throw error;
	}

	const streamed = await forwardDeltas({
		context,
		generation,
		abort,
		alerted,
		write,
	});
	// Provider totals replace estimates. The crossing chunk remains recorded.
	const settled = await generation.settle();
	const finished = await finishUsage(context, settled, alerted);

	if (streamed.quotaHit || !finished.consumed.allowed) {
		await denyQuota(context, finished.limits, write);
		return;
	}
	if (streamed.failure) {
		throw streamed.failure;
	}

	await completeGeneration({ context, settled, finished, write });
}

/**
 * The 200 body. Every failure from here on is an `error` frame, because the
 * status line is already on the wire by the time the first token arrives.
 */
export function generationResponse(context: GenerationContext): Response {
	const encoder = new TextEncoder();
	let disconnected = false;

	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			const write: Write = (frame) => {
				if (disconnected) {
					return;
				}
				try {
					controller.enqueue(encoder.encode(encodeFrame(frame)));
				} catch {
					// The reader hung up. Stop writing, but let metering finish so the
					// tokens the subscriber already spent are still recorded.
					disconnected = true;
				}
			};

			try {
				await pump(context, write);
			} catch (error) {
				console.error("[generate] generation stream failed", error);
				write({
					type: "error",
					error: "upstream_unavailable",
					message: UPSTREAM_UNAVAILABLE,
				});
				await emit(
					"app.generate_denied",
					{
						subscription_id: context.subject.chargebeeSubscriptionId,
						model: context.input.model,
						error: "upstream_unavailable",
					},
					{ source: "app", trace_id: context.traceId },
				);
			} finally {
				if (!disconnected) {
					controller.close();
				}
			}
		},

		cancel() {
			disconnected = true;
		},
	});

	return new Response(body, { headers: STREAM_HEADERS });
}
