import type { BetterAuthPlugin } from "better-auth";

/**
 * Registers the durable usage-event archive so the Better Auth CLI manages its
 * columns alongside the rest of the schema.
 *
 * The table itself is *not* created by the CLI: it is partitioned by week, and
 * `db.schema.createTable` cannot emit `PARTITION BY RANGE`. `lib/usage/
 * partitions.ts` creates the parent, and the CLI's introspection reports a
 * partitioned table as an existing `BASE TABLE`, so it skips creation and
 * limits itself to `ALTER TABLE ADD COLUMN` — which propagates to partitions.
 * `scripts/migrate-usage.ts` guarantees that ordering.
 *
 * Note the deliberate absence of an `indexes` block. Better Auth's index
 * introspection is scoped to `pg_class.relkind = 'r'`, so the single index on
 * the partitioned parent is invisible to it and every migration would retry
 * `CREATE INDEX` and fail. The DDL owns the index.
 */
export const usagePlugin = {
  id: "usage-archive",
  schema: {
    usageEvent: {
      modelName: "usage_event",
      fields: {
        // Chargebee's `deduplication_id` — the generation's uuidv7 trace id.
        // Doubles as the event's identity here, so no separate `id` column.
        deduplicationId: { type: "string", required: true },
        subscriptionId: { type: "string", required: true },
        // Partition key. When the usage happened, not when it was flushed.
        usageTimestamp: { type: "date", required: true },
        model: { type: "string", required: true },
        inputTokens: { type: "number", required: true },
        outputTokens: { type: "number", required: true },
        // Credits x 1000. `consumeGenerationUsage` divides milli-credits by
        // 1000, so the value is fractional and an integer column would
        // truncate it; Better Auth has no decimal type to declare instead.
        creditsMilli: { type: "number", required: true },
        usageSource: { type: "string", required: true },
        planId: { type: "string", required: true },
      },
    },
  },
} satisfies BetterAuthPlugin;
