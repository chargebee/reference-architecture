import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebhookEvent } from "chargebee";

const mocks = vi.hoisted(() => ({
	query: vi.fn(async () => ({ rows: [{ exists: 1 }] })),
	enqueueEntitlementSync: vi.fn(async () => undefined),
	refreshSnapshot: vi.fn(async () => ({
		source: "api" as const,
		snapshot: {
			schemaVersion: 1 as const,
			generatedAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
			entitlements: {},
		},
	})),
	deleteSnapshot: vi.fn(async () => undefined),
}));

vi.mock("@/lib/db", () => ({
	getPool: async () => ({ query: mocks.query }),
}));
vi.mock("@/lib/events/emit", () => ({
	emit: vi.fn(async () => undefined),
}));
vi.mock("./queue", () => ({
	ENTITLEMENT_SYNC_JOB: "entitlements.sync",
	enqueueEntitlementSync: mocks.enqueueEntitlementSync,
}));
vi.mock("./provider", () => ({
	entitlements: {
		refreshSnapshot: mocks.refreshSnapshot,
		deleteSnapshot: mocks.deleteSnapshot,
	},
}));
vi.mock("./postgres-store", () => ({
	recordEntitlementSyncSource: vi.fn(async () => undefined),
}));

import { processEntitlementWebhook, runEntitlementSyncJob } from "./sync";
import { ENTITLEMENT_SYNC_JOB, type EntitlementSyncJob } from "./queue";

function event(event_type: string, content: Record<string, unknown>) {
	return {
		id: `event-${event_type}`,
		event_type,
		content,
	} as WebhookEvent;
}

describe("entitlement webhook routing", () => {
	beforeEach(() => {
		mocks.query.mockClear();
		mocks.refreshSnapshot.mockClear();
		mocks.deleteSnapshot.mockClear();
		mocks.enqueueEntitlementSync.mockClear();
	});

	it("routes direct subscription entitlement events", async () => {
		await expect(
			processEntitlementWebhook(
				event("subscription_entitlements_updated", {
					subscription_entitlements_updated_detail: {
						subscription_id: "sub-direct",
						has_next: true,
					},
				}),
			),
		).resolves.toBe(true);
		expect(mocks.refreshSnapshot).toHaveBeenCalledWith({
			subscriptionId: "sub-direct",
		});
	});

	it("fans inline impacted subscriptions out to full refreshes", async () => {
		await expect(
			processEntitlementWebhook(
				event("entitlement_overrides_updated", {
					impacted_subscription: {
						subscription_ids: ["sub-one", "sub-two", "sub-one"],
					},
				}),
			),
		).resolves.toBe(true);
		expect(mocks.refreshSnapshot).toHaveBeenCalledTimes(2);
		expect(mocks.refreshSnapshot).toHaveBeenCalledWith({
			subscriptionId: "sub-one",
		});
		expect(mocks.refreshSnapshot).toHaveBeenCalledWith({
			subscriptionId: "sub-two",
		});
	});

	it("queues the initial fetch after the subscription is mirrored", async () => {
		await expect(
			processEntitlementWebhook(
				event("subscription_created", {
					subscription: { id: "sub-free" },
				}),
			),
		).resolves.toBe(true);

		expect(mocks.enqueueEntitlementSync).toHaveBeenCalledWith({
			reason: "subscription_created",
			chargebeeSubscriptionId: "sub-free",
		});
		expect(mocks.refreshSnapshot).not.toHaveBeenCalled();
	});

	it("refreshes on every subscription change that can move entitlements", async () => {
		for (const eventType of [
			"subscription_changed_with_backdating",
			"subscription_reactivated",
			"subscription_resumed",
			"subscription_paused",
		]) {
			await expect(
				processEntitlementWebhook(
					event(eventType, { subscription: { id: `sub-${eventType}` } }),
				),
			).resolves.toBe(true);
		}
		expect(mocks.refreshSnapshot).toHaveBeenCalledTimes(4);
	});

	it("deletes snapshots once a subscription stops granting anything", async () => {
		for (const eventType of [
			"subscription_cancelled",
			"subscription_deleted",
			"subscription_moved_out",
		]) {
			await processEntitlementWebhook(
				event(eventType, { subscription: { id: `sub-${eventType}` } }),
			);
			expect(mocks.deleteSnapshot).toHaveBeenCalledWith({
				subscriptionId: `sub-${eventType}`,
			});
		}
		expect(mocks.refreshSnapshot).not.toHaveBeenCalled();
	});

	it("ignores events that cannot change entitlements", async () => {
		await expect(
			processEntitlementWebhook(
				event("subscription_renewal_reminder", {
					subscription: { id: "sub-reminder" },
				}),
			),
		).resolves.toBe(false);
		expect(mocks.refreshSnapshot).not.toHaveBeenCalled();
		expect(mocks.deleteSnapshot).not.toHaveBeenCalled();
	});
});

describe("queued entitlement sync jobs", () => {
	beforeEach(() => {
		mocks.refreshSnapshot.mockClear();
		mocks.enqueueEntitlementSync.mockClear();
	});

	it("primes the subscription named by the job", async () => {
		const job: EntitlementSyncJob = {
			job: ENTITLEMENT_SYNC_JOB,
			id: "job-subscription-created",
			requestedAt: new Date().toISOString(),
			reason: "subscription_created",
			chargebeeSubscriptionId: "sub-free",
		};

		await runEntitlementSyncJob(job);

		expect(mocks.refreshSnapshot).toHaveBeenCalledWith({
			subscriptionId: "sub-free",
		});
	});
});
