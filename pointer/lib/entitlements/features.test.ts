import { describe, expect, it, vi, beforeEach } from "vitest";
import type { EntitlementResolution } from "@chargebee/entitlements";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getValue: vi.fn(),
}));

// The catalog binds every feature to the client, so a fake client is all that
// stands between the real `Feature` instances and a snapshot.
vi.mock("./provider", async () => {
  const { Feature } = await import("@chargebee/entitlements");
  const client = { getValue: mocks.getValue };
  return {
    entitlements: {
      feature: <T,>(featureId: string, defaultValue: T) =>
        new Feature<T>(featureId, defaultValue, client),
    },
  };
});

import {
  EntitlementEvaluationError,
  features,
  resolveEntitlements,
} from "./features";
import type { EntitlementSubject } from "./subject";

const subject: EntitlementSubject = {
  customerType: "user",
  referenceId: "user-1",
  chargebeeCustomerId: "customer-1",
  chargebeeSubscriptionId: "sub-1",
  subscription: {
    id: "local-1",
    referenceId: "user-1",
    chargebeeSubscriptionId: "sub-1",
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

/** Answers each feature with whatever the plan grants, defaults otherwise. */
function grant(values: Record<string, unknown>) {
  mocks.getValue.mockImplementation(
    (featureId: string, defaultValue: unknown): EntitlementResolution<unknown> =>
      featureId in values
        ? { value: values[featureId], reason: "CACHED" }
        : {
            value: defaultValue,
            reason: "ERROR",
            errorCode: "FLAG_NOT_FOUND",
            errorMessage: `${featureId} not found`,
          },
  );
}

describe("entitlement catalog", () => {
  beforeEach(() => {
    mocks.getValue.mockReset();
  });

  it("evaluates every feature against the subscription target", async () => {
    grant({});

    await resolveEntitlements(subject);

    expect(mocks.getValue).toHaveBeenCalledTimes(
      Object.keys(features).length,
    );
    for (const call of mocks.getValue.mock.calls) {
      expect(call[2]).toEqual({ subscriptionId: "sub-1" });
    }
  });

  it("resolves the plan's values into the derived limits", async () => {
    grant({
      f_input_tokens_daily: 1_000_000,
      f_output_tokens_daily: 200_000,
      f_credits_monthly: 500,
      f_api_rate_per_minute: 300,
      f_max_seats: Number.POSITIVE_INFINITY,
      f_sso: true,
      f_models: "advanced",
    });

    await expect(resolveEntitlements(subject)).resolves.toEqual({
      limits: {
        inputTokensDaily: 1_000_000,
        outputTokensDaily: 200_000,
        creditsMonthly: 500,
        apiRatePerMinute: 300,
        maxSeats: Number.POSITIVE_INFINITY,
        sso: true,
        models: "advanced",
      },
      pending: false,
    });
  });

  it("falls back to the free-tier floor for features the plan omits", async () => {
    grant({});

    const { limits, pending } = await resolveEntitlements(subject);

    expect(limits).toEqual({
      inputTokensDaily: 50_000,
      outputTokensDaily: 10_000,
      creditsMonthly: 0,
      apiRatePerMinute: 30,
      maxSeats: 1,
      sso: false,
      models: "basic",
    });
    expect(pending).toBe(false);
  });

  it("reports a still-loading snapshot as pending rather than an error", async () => {
    mocks.getValue.mockImplementation(
      (_featureId: string, defaultValue: unknown) => ({
        value: defaultValue,
        reason: "STALE",
        flagMetadata: { snapshotPending: true },
      }),
    );

    const { limits, pending } = await resolveEntitlements(subject);

    expect(pending).toBe(true);
    expect(limits.models).toBe("basic");
  });

  it("throws when a value cannot be read as the declared type", async () => {
    mocks.getValue.mockImplementation(
      (featureId: string, defaultValue: unknown) =>
        featureId === features.maxSeats.featureId
          ? {
              value: defaultValue,
              reason: "ERROR",
              errorCode: "TYPE_MISMATCH",
              errorMessage: "not a numeric entitlement",
            }
          : { value: defaultValue, reason: "CACHED" },
    );

    await expect(resolveEntitlements(subject)).rejects.toThrow(
      EntitlementEvaluationError,
    );
  });

  it("rejects a model tier this build does not know", async () => {
    grant({ f_models: "platinum" });

    await expect(resolveEntitlements(subject)).rejects.toThrow(
      /Unknown model entitlement tier: platinum/,
    );
  });
});
