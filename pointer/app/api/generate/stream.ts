import {
  features,
  type ResolvedEntitlements,
} from "@/lib/entitlements/features";
import {
  EntitlementGateError,
  QUOTA_EXHAUSTED,
  getUsageSnapshot,
  meterGeneration,
} from "@/lib/entitlements/gate";
import type { EntitlementSubject } from "@/lib/entitlements/subject";
import { emit } from "@/lib/events/emit";
import { streamGeneration, type GenerateInput } from "@/lib/generate";
import { claimUsageThreshold } from "@/lib/usage/counters";
import { recordUsageEvent } from "@/lib/usage/events";

import {
  NDJSON_CONTENT_TYPE,
  encodeFrame,
  upgradeHint,
  type GenerateFrame,
} from "./frames";

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
  /** Output tokens the subscriber can pay for. The stream is cut here. */
  outputTokenBudget: number;
  traceId: string;
};

type Write = (frame: GenerateFrame) => void;

async function pump(context: GenerationContext, write: Write): Promise<void> {
  const { subject, entitlements, input, traceId } = context;
  const trace = { source: "app" as const, trace_id: traceId };

  const abort = new AbortController();
  const generation = streamGeneration(input, abort.signal);

  // Deltas carry no token counts, so the budget is policed on a running
  // estimate and the upstream call is cut the moment it is spent.
  let overBudget = false;
  for await (const text of generation.deltas) {
    write({ type: "delta", text });
    if (generation.streamedTokens() <= context.outputTokenBudget) {
      continue;
    }

    overBudget = true;
    abort.abort();
    break;
  }

  // Bill what the model produced, cut or not. A denial here means the ceiling
  // was crossed anyway, which is the condition the budget watch fires on.
  const settled = await generation.settle();
  let consumed;
  try {
    consumed = await meterGeneration(subject, entitlements, settled);
  } catch (error) {
    if (!(error instanceof EntitlementGateError)) {
      throw error;
    }
  }

  const limits = await getUsageSnapshot(subject, entitlements);

  if (overBudget || !consumed) {
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
        subscription_id: subject.chargebeeSubscriptionId,
        model: input.model,
        error: "quota_exceeded",
        feature_id: features.creditsMonthly.featureId,
      },
      trace,
    );
    return;
  }

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
    trace,
  );

  // Buffered for Chargebee only on the settled path, so what reaches the
  // billing system of record matches what the local counters were charged.
  // A denial never incremented them, so there is no usage to report.
  await recordUsageEvent({
    deduplicationId: traceId,
    subscriptionId: subject.chargebeeSubscriptionId,
    usageTimestamp: Date.now(),
    properties: {
      generation_id: traceId,
      model: input.model,
      input_tokens: settled.inputTokens,
      output_tokens: settled.outputTokens,
      credits_consumed: consumed.creditsConsumed,
      usage_source: consumed.source,
      plan_id: subject.subscription.planId ?? "unknown",
    },
  });

  for (const crossed of limits.thresholds) {
    if (!(await claimUsageThreshold(subject, crossed.featureId))) {
      continue;
    }
    await emit(
      "app.usage_threshold",
      {
        subscription_id: subject.chargebeeSubscriptionId,
        feature_id: crossed.featureId,
        percent: crossed.percent,
      },
      trace,
    );
  }
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
