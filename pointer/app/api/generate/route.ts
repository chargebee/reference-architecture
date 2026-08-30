import { type NextRequest } from "next/server";
import { v7 as uuidv7 } from "uuid";

import { auth } from "@/lib/auth";
import { resolveEntitlements } from "@/lib/entitlements/features";
import {
  EntitlementGateError,
  admitGeneration,
} from "@/lib/entitlements/gate";
import { resolveEntitlementSubject } from "@/lib/entitlements/subject";
import { emit } from "@/lib/events/emit";
import {
  DEFAULT_OUTPUT_TOKENS,
  estimateTokens,
  validateGenerateInput,
} from "@/lib/generate";

import { upgradeHint } from "./frames";
import { generationResponse } from "./stream";

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

  // One id ties every event this request emits, including a pre-flight denial
  // that never reaches the model.
  const traceId = uuidv7();
  const inputTokens = estimateTokens(input.prompt);
  await emit(
    "app.generate_requested",
    {
      subscription_id: subject.chargebeeSubscriptionId,
      model: input.model,
      input_tokens: inputTokens,
      requested_output_tokens: input.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS,
    },
    { source: "app", trace_id: traceId },
  );

  // Everything that can still become an HTTP status is settled here. Once the
  // stream opens the response is a 200 and failures ride in-band as frames.
  let entitlementsPending = false;
  try {
    // While the snapshot loads, entitlements resolve to the free-tier floor so
    // a new subscriber can generate without waiting on Chargebee.
    const entitlements = await resolveEntitlements(subject);
    entitlementsPending = entitlements.pending;
    const admitted = await admitGeneration(subject, entitlements, {
      model: input.model,
      inputTokens,
    });

    return generationResponse({
      subject,
      entitlements,
      input,
      outputTokenBudget: admitted.outputTokenBudget,
      traceId,
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
        { source: "app", trace_id: traceId },
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
      { source: "app", trace_id: traceId },
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
