import type { BetterAuthPlugin } from "better-auth";

/**
 * Registers the durable subscription-entitlement mirror. Better Auth adds an
 * `id` text primary key to each model; application writes use the unique
 * target/feature keys for idempotent upserts.
 */
export const entitlementsPlugin = {
	id: "chargebee-entitlements",
	schema: {
		entitlementSnapshot: {
			modelName: "entitlement_snapshot",
			fields: {
				targetKey: { type: "string", required: true, unique: true },
				chargebeeSubscriptionId: {
					type: "string",
					required: true,
					unique: true,
				},
				localSubscriptionId: { type: "string", required: false },
				referenceId: { type: "string", required: false },
				customerType: { type: "string", required: false },
				snapshotVersion: { type: "number", required: true, bigint: true },
				generatedAt: { type: "date", required: true },
				expiresAt: { type: "date", required: true },
				syncedAt: { type: "date", required: true },
				sourceEventId: { type: "string", required: false },
				sourceEventType: { type: "string", required: false },
			},
		},
		subscriptionEntitlement: {
			modelName: "subscription_entitlement",
			fields: {
				featureKey: { type: "string", required: true, unique: true },
				targetKey: { type: "string", required: true },
				chargebeeSubscriptionId: { type: "string", required: true },
				featureId: { type: "string", required: true },
				value: { type: "string", required: false },
				name: { type: "string", required: false },
				featureName: { type: "string", required: false },
				featureUnit: { type: "string", required: false },
				featureType: { type: "string", required: false },
				isEnabled: { type: "boolean", required: true },
				isOverridden: { type: "boolean", required: false },
				entitlementExpiresAt: {
					type: "number",
					required: false,
					bigint: true,
				},
			},
		},
	},
} satisfies BetterAuthPlugin;
