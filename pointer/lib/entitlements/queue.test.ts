import { describe, expect, it } from "vitest";

import { ENTITLEMENT_SYNC_JOB, isEntitlementSyncJob } from "./queue";

describe("isEntitlementSyncJob", () => {
	it("accepts a subscription-created job with an exact subscription target", () => {
		expect(
			isEntitlementSyncJob({
				job: ENTITLEMENT_SYNC_JOB,
				id: "job-1",
				requestedAt: new Date().toISOString(),
				reason: "subscription_created",
				chargebeeSubscriptionId: "sub-free",
			}),
		).toBe(true);
	});

	it("rejects jobs without a target or known reason", () => {
		expect(
			isEntitlementSyncJob({
				job: ENTITLEMENT_SYNC_JOB,
				id: "job-1",
				requestedAt: new Date().toISOString(),
				reason: "subscription_created",
			}),
		).toBe(false);
		expect(
			isEntitlementSyncJob({
				job: ENTITLEMENT_SYNC_JOB,
				id: "job-1",
				requestedAt: new Date().toISOString(),
				reason: "unknown",
				chargebeeSubscriptionId: "sub-free",
			}),
		).toBe(false);
	});
});
