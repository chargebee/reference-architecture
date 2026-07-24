import type { BetterAuthPlugin } from "better-auth";

/**
 * A tiny Better Auth plugin whose only job is to register the
 * `chargebee_resource_version` table with Better Auth's schema so the bundled
 * CLI (`@better-auth/cli migrate` / `generate`) creates and maintains it —
 * no bespoke SQL migration script required. See
 * https://better-auth.com/docs/concepts/database#plugins-schema.
 *
 * The table is the resource-version store used by the webhook worker for
 * out-of-order overwrite protection (and, as a side effect, duplicate-delivery
 * protection). Better Auth adds an `id` text primary key automatically; we key
 * upserts off the unique `resourceKey` ("<resourceType>:<resourceId>").
 */
export const webhookCorrectnessPlugin = {
  id: "webhook-correctness",
  schema: {
    chargebeeResourceVersion: {
      modelName: "chargebee_resource_version",
      fields: {
        // "<resourceType>:<resourceId>", e.g. "customer:cbdemo_alex".
        resourceKey: { type: "string", required: true, unique: true },
        // Chargebee resource_version is a large monotonic value (ms-based),
        // so it must be a bigint to avoid int32 overflow.
        resourceVersion: { type: "number", required: true, bigint: true },
        updatedAt: {
          type: "date",
          required: true,
          defaultValue: () => new Date(),
        },
      },
    },
  },
} satisfies BetterAuthPlugin;
