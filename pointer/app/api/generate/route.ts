import { type NextRequest } from "next/server";

import { auth } from "@/lib/auth";
import { resolveEntitlements } from "@/lib/entitlements/features";
import {
  EntitlementGateError,
  enforceGeneration,
  getUsageSnapshot,
} from "@/lib/entitlements/gate";
import { resolveEntitlementSubject } from "@/lib/entitlements/subject";
import { emit } from "@/lib/events/emit";
import {
  simulateGeneration,
  validateGenerateInput,
} from "@/lib/generate/simulate";
import { claimUsageThreshold } from "@/lib/usage/counters";

function upgradeHint(action: "upgrade" | "buy_credits" = "upgrade") {
  return { action, href: "/choose-plan" as const };
}

export async function POST(request: NextRequest): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return Response.json(
      { error: "unauthenticated", message: "Sign in to generate" },
      { status: 401 },
    );
  }

  let input;
  try {
    input = validateGenerateInput(await request.json());
  } catch (error) {
    return Response.json(
      {
        error: "invalid_request",
        message: error instanceof Error ? error.message : "Invalid request",
      },
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
        message: "Choose a plan before generating",
        upgradeHint: upgradeHint(),
      },
      { status: 403 },
    );
  }

  const simulated = simulateGeneration(input);
  await emit(
    "app.generate_requested",
    {
      subscription_id: subject.chargebeeSubscriptionId,
      model: input.model,
      input_tokens: simulated.inputTokens,
      requested_output_tokens: simulated.outputTokens,
    },
    { source: "app" },
  );

  let entitlementsPending = false;
  try {
    // While the snapshot loads, entitlements resolve to the free-tier floor so
    // a new subscriber can generate without waiting on Chargebee.
    const entitlements = await resolveEntitlements(subject);
    entitlementsPending = entitlements.pending;
    const consumed = await enforceGeneration(subject, entitlements, {
      model: input.model,
      inputTokens: simulated.inputTokens,
      outputTokens: simulated.outputTokens,
    });
    const limits = await getUsageSnapshot(subject, entitlements);
    await emit(
      "app.generate_completed",
      {
        subscription_id: subject.chargebeeSubscriptionId,
        model: input.model,
        input_tokens: simulated.inputTokens,
        output_tokens: simulated.outputTokens,
        credits_consumed: consumed.creditsConsumed,
        usage_source: consumed.source,
      },
      { source: "app", trace_id: simulated.id },
    );
    for (const crossed of limits.thresholds) {
      if (!(await claimUsageThreshold(subject, crossed.featureId))) continue;
      await emit(
        "app.usage_threshold",
        {
          subscription_id: subject.chargebeeSubscriptionId,
          feature_id: crossed.featureId,
          percent: crossed.percent,
        },
        { source: "app", trace_id: simulated.id },
      );
    }

    return Response.json({
      id: simulated.id,
      model: simulated.model,
      output: simulated.output,
      usage: {
        inputTokens: simulated.inputTokens,
        outputTokens: simulated.outputTokens,
        creditsConsumed: consumed.creditsConsumed,
        source: consumed.source,
      },
      limits,
    });
  } catch (error) {
    if (error instanceof EntitlementGateError) {
      await emit(
        "app.generate_denied",
        {
          subscription_id: subject.chargebeeSubscriptionId,
          model: input.model,
          error: error.code,
          feature_id: error.featureId,
        },
        { source: "app", trace_id: simulated.id },
      );
      const headers = new Headers();
      if (error.retryAfterSeconds) {
        headers.set("Retry-After", String(error.retryAfterSeconds));
      }
      return Response.json(
        {
          error: error.code,
          message: entitlementsPending
            ? `${error.message}. Your plan entitlements are still loading.`
            : error.message,
          featureId: error.featureId,
          entitlementsPending,
          upgradeHint: upgradeHint(),
          ...(error.retryAfterSeconds
            ? { retryAfterSeconds: error.retryAfterSeconds }
            : {}),
        },
        { status: error.status, headers },
      );
    }

    console.error("[generate] entitlement enforcement failed", error);
    await emit(
      "app.generate_denied",
      {
        subscription_id: subject.chargebeeSubscriptionId,
        model: input.model,
        error: "enforcement_unavailable",
      },
      { source: "app", trace_id: simulated.id },
    );
    return Response.json(
      {
        error: "enforcement_unavailable",
        message: "Local entitlement enforcement is temporarily unavailable",
      },
      { status: 503 },
    );
  }
}
