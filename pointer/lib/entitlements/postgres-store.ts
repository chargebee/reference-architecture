import type {
  ChargebeeEntitlement,
  ChargebeeEntitlementsSnapshot,
} from "@chargebee/openfeature";
import type { EntitlementsStorage } from "@chargebee/openfeature/cache";
import { v7 as uuidv7 } from "uuid";

import { getPool } from "@/lib/db";

type SnapshotRow = {
  targetKey: string;
  chargebeeSubscriptionId: string;
  generatedAt: Date;
  expiresAt: Date;
  syncedAt: Date;
  snapshotVersion: string;
  sourceEventId: string | null;
  sourceEventType: string | null;
};

type EntitlementRow = {
  featureId: string;
  value: string | null;
  name: string | null;
  featureName: string | null;
  featureUnit: string | null;
  featureType: string | null;
  isEnabled: boolean;
  isOverridden: boolean | null;
  entitlementExpiresAt: string | null;
};

function subscriptionIdFromTargetKey(targetKey: string): string {
  const marker = ":subscription:";
  const index = targetKey.lastIndexOf(marker);
  if (index < 0) {
    throw new Error(`Only subscription entitlement targets are supported: ${targetKey}`);
  }
  return decodeURIComponent(targetKey.slice(index + marker.length));
}

function entitlementFromRow(row: EntitlementRow): ChargebeeEntitlement {
  return {
    featureId: row.featureId,
    isEnabled: row.isEnabled,
    ...(row.value !== null ? { value: row.value } : {}),
    ...(row.name !== null ? { name: row.name } : {}),
    ...(row.featureName !== null ? { featureName: row.featureName } : {}),
    ...(row.featureUnit !== null ? { featureUnit: row.featureUnit } : {}),
    ...(row.featureType !== null ? { featureType: row.featureType } : {}),
    ...(row.isOverridden !== null
      ? { isOverridden: row.isOverridden }
      : {}),
    ...(row.entitlementExpiresAt !== null
      ? { expiresAt: Number(row.entitlementExpiresAt) }
      : {}),
  };
}

/**
 * Durable source of truth for subscription entitlements. Rows are kept past
 * `expiresAt`: the provider serves them while refreshing from Chargebee, so a
 * Chargebee outage never downgrades an existing subscriber.
 */
export class PostgresEntitlementsStore implements EntitlementsStorage {
  async get(
    targetKey: string,
  ): Promise<ChargebeeEntitlementsSnapshot | undefined> {
    const pool = await getPool();
    const header = await pool.query<SnapshotRow>(
      `SELECT "targetKey", "chargebeeSubscriptionId", "generatedAt",
              "expiresAt", "syncedAt", "snapshotVersion",
              "sourceEventId", "sourceEventType"
         FROM entitlement_snapshot
        WHERE "targetKey" = $1`,
      [targetKey],
    );
    const snapshot = header.rows[0];
    if (!snapshot) return undefined;

    const rows = await pool.query<EntitlementRow>(
      `SELECT "featureId", value, name, "featureName", "featureUnit",
              "featureType", "isEnabled", "isOverridden",
              "entitlementExpiresAt"
         FROM subscription_entitlement
        WHERE "targetKey" = $1`,
      [targetKey],
    );

    return {
      schemaVersion: 1,
      targetMode: "subscription",
      generatedAt: snapshot.generatedAt.toISOString(),
      expiresAt: snapshot.expiresAt.toISOString(),
      entitlements: Object.fromEntries(
        rows.rows.map((row) => [row.featureId, entitlementFromRow(row)]),
      ),
    };
  }

  async set(
    targetKey: string,
    snapshot: ChargebeeEntitlementsSnapshot,
  ): Promise<void> {
    if (snapshot.targetMode !== "subscription") {
      throw new Error("Pointer persists subscription entitlement snapshots only");
    }
    const chargebeeSubscriptionId = subscriptionIdFromTargetKey(targetKey);
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const metadata = await client.query<{
        id: string;
        referenceId: string;
        customerType: "user" | "organization";
      }>(
        `SELECT s.id, s."referenceId",
                CASE WHEN o.id IS NULL THEN 'user' ELSE 'organization' END
                  AS "customerType"
           FROM subscription s
           LEFT JOIN organization o ON o.id = s."referenceId"
          WHERE s."chargebeeSubscriptionId" = $1
          LIMIT 1`,
        [chargebeeSubscriptionId],
      );
      const subject = metadata.rows[0];
      const now = new Date();
      await client.query(
        `INSERT INTO entitlement_snapshot
                (id, "targetKey", "chargebeeSubscriptionId",
                 "localSubscriptionId", "referenceId", "customerType",
                 "snapshotVersion", "generatedAt", "expiresAt", "syncedAt")
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT ("targetKey")
         DO UPDATE SET "chargebeeSubscriptionId" = EXCLUDED."chargebeeSubscriptionId",
                       "localSubscriptionId" = EXCLUDED."localSubscriptionId",
                       "referenceId" = EXCLUDED."referenceId",
                       "customerType" = EXCLUDED."customerType",
                       "snapshotVersion" = EXCLUDED."snapshotVersion",
                       "generatedAt" = EXCLUDED."generatedAt",
                       "expiresAt" = EXCLUDED."expiresAt",
                       "syncedAt" = EXCLUDED."syncedAt"`,
        [
          uuidv7(),
          targetKey,
          chargebeeSubscriptionId,
          subject?.id ?? null,
          subject?.referenceId ?? null,
          subject?.customerType ?? null,
          Date.now(),
          new Date(snapshot.generatedAt),
          new Date(snapshot.expiresAt),
          now,
        ],
      );

      await client.query(
        `DELETE FROM subscription_entitlement WHERE "targetKey" = $1`,
        [targetKey],
      );
      for (const entitlement of Object.values(snapshot.entitlements)) {
        await client.query(
          `INSERT INTO subscription_entitlement
                  (id, "featureKey", "targetKey", "chargebeeSubscriptionId",
                   "featureId", value, name, "featureName", "featureUnit",
                   "featureType", "isEnabled", "isOverridden",
                   "entitlementExpiresAt")
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            uuidv7(),
            `${chargebeeSubscriptionId}:${entitlement.featureId}`,
            targetKey,
            chargebeeSubscriptionId,
            entitlement.featureId,
            entitlement.value ?? null,
            entitlement.name ?? null,
            entitlement.featureName ?? null,
            entitlement.featureUnit ?? null,
            entitlement.featureType ?? null,
            entitlement.isEnabled,
            entitlement.isOverridden ?? null,
            entitlement.expiresAt ?? null,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async delete(targetKey: string): Promise<void> {
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM subscription_entitlement WHERE "targetKey" = $1`,
        [targetKey],
      );
      await client.query(
        `DELETE FROM entitlement_snapshot WHERE "targetKey" = $1`,
        [targetKey],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export type EntitlementSnapshotDiagnostics = {
  subscriptionId: string;
  version: string;
  generatedAt: string;
  expiresAt: string;
  syncedAt: string;
  sourceEventId: string | null;
  sourceEventType: string | null;
};

export async function getEntitlementSnapshotDiagnostics(
  chargebeeSubscriptionId: string,
): Promise<EntitlementSnapshotDiagnostics | null> {
  const pool = await getPool();
  const result = await pool.query<SnapshotRow>(
    `SELECT "targetKey", "chargebeeSubscriptionId", "generatedAt",
            "expiresAt", "syncedAt", "snapshotVersion",
            "sourceEventId", "sourceEventType"
       FROM entitlement_snapshot
      WHERE "chargebeeSubscriptionId" = $1`,
    [chargebeeSubscriptionId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    subscriptionId: row.chargebeeSubscriptionId,
    version: row.snapshotVersion,
    generatedAt: row.generatedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    syncedAt: row.syncedAt.toISOString(),
    sourceEventId: row.sourceEventId,
    sourceEventType: row.sourceEventType,
  };
}

export async function recordEntitlementSyncSource(
  chargebeeSubscriptionId: string,
  event: { id: string; event_type: string },
): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE entitlement_snapshot
        SET "sourceEventId" = $1, "sourceEventType" = $2
      WHERE "chargebeeSubscriptionId" = $3`,
    [event.id, event.event_type, chargebeeSubscriptionId],
  );
}
