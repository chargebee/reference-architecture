import { describe, expect, it } from "vitest";

import { itemEntitlements, planLimits, type PlanId } from "./catalog";

const fields = {
  f_input_tokens_daily: "inputTokensDaily",
  f_output_tokens_daily: "outputTokensDaily",
  f_credits_monthly: "creditsMonthly",
  f_api_rate_per_minute: "apiRatePerMinute",
  f_max_seats: "maxSeats",
  f_sso: "sso",
  f_models: "models",
} as const;

function normalized(value: unknown): string {
  return String(value);
}

describe("catalog entitlement mirror", () => {
  it("keeps every plan limit aligned with its Chargebee entitlement", () => {
    for (const [planId, entitlements] of Object.entries(itemEntitlements) as [
      PlanId,
      (typeof itemEntitlements)[PlanId],
    ][]) {
      expect(entitlements).toHaveLength(Object.keys(fields).length);
      for (const entitlement of entitlements) {
        const field = fields[entitlement.feature_id as keyof typeof fields];
        expect(field).toBeDefined();
        expect(normalized(planLimits[planId][field])).toBe(entitlement.value);
      }
    }
  });
});
