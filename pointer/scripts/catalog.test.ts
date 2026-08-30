import { describe, expect, it } from "vitest";

import {
  itemEntitlements,
  meteredFeatures,
  planLimits,
  usageEventColumns,
  type PlanId,
} from "./catalog";

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

/** `SUM(input_tokens)` -> `input_tokens`. Chargebee rejects undeclared columns. */
const AGGREGATE = /(?:SUM|COUNT|MIN|MAX|AVG|COUNT_DISTINCT)\((\w+)\)/gi;

describe("metered features", () => {
  it("only aggregates columns the event schema declares", () => {
    for (const spec of meteredFeatures) {
      const declared = spec.column_definitions.map((c) => c.column_name);
      const referenced = [...spec.query.matchAll(AGGREGATE)].map((m) => m[1]);

      expect(referenced.length).toBeGreaterThan(0);
      for (const column of referenced) {
        expect(declared).toContain(column);
        expect(usageEventColumns).toHaveProperty(column);
      }
    }
  });

  it("declares each column with the schema's data type", () => {
    for (const spec of meteredFeatures) {
      for (const column of spec.column_definitions) {
        expect(column.data_type).toBe(usageEventColumns[column.column_name]);
      }
    }
  });

  it("keeps metrics and derived ids unique", () => {
    const metrics = meteredFeatures.map((spec) => spec.metric);
    const ids = meteredFeatures.map((spec) => spec.expectedId);

    expect(new Set(metrics).size).toBe(metrics.length);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
