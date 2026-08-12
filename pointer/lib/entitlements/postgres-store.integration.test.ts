import { afterAll, describe, expect, it } from "vitest";
import { createEntitlementsSnapshot } from "@chargebee/openfeature";

import { getPool } from "@/lib/db";

import { PostgresEntitlementsStore } from "./postgres-store";

const postgresTests =
  process.env.RUN_POSTGRES_TESTS === "1" ? describe : describe.skip;

postgresTests("Postgres entitlement store", () => {
  const store = new PostgresEntitlementsStore();
  const subscriptionId = `test-${process.pid}-${Date.now()}`;
  const key = `pointer:entitlements:v1:subscription:${subscriptionId}`;

  afterAll(async () => {
    await store.delete(key);
    await (await getPool()).end();
  });

  it("round-trips resolved values and override metadata", async () => {
    const snapshot = createEntitlementsSnapshot(
      "subscription",
      [
        {
          featureId: "f_sso",
          featureType: "switch",
          value: "true",
          isEnabled: true,
          isOverridden: true,
        },
        {
          featureId: "f_api_rate_per_minute",
          featureType: "quantity",
          featureUnit: "request",
          value: "300",
          isEnabled: true,
        },
      ],
      60_000,
    );

    await store.set(key, snapshot);
    await expect(store.get(key)).resolves.toMatchObject({
      targetMode: "subscription",
      entitlements: {
        f_sso: { value: "true", isOverridden: true },
        f_api_rate_per_minute: {
          value: "300",
          featureUnit: "request",
        },
      },
    });
  });

  it("keeps expired snapshots readable so the provider can refresh them", async () => {
    const expired = createEntitlementsSnapshot(
      "subscription",
      [{ featureId: "f_sso", value: "true", isEnabled: true }],
      -60_000,
    );

    await store.set(key, expired);

    await expect(store.get(key)).resolves.toMatchObject({
      expiresAt: expired.expiresAt,
    });
  });
});
