import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "@/lib/auth";

const mocks = vi.hoisted(() => ({
	chargebeeCustomerId: "cust-1" as string | null,
	list: vi.fn(),
	process: vi.fn(async () => undefined),
	syncEntitlements: vi.fn(async () => undefined),
}));

vi.mock("@/lib/auth", () => ({ auth: { $context: Promise.resolve({}) } }));
vi.mock("@chargebee/better-auth", () => ({
	createChargebeeWebhookProcessor: () => ({ process: mocks.process }),
}));
vi.mock("@/plugins/chargebee-plugin", () => ({
	chargebeeClient: { subscription: { list: mocks.list } },
	chargebeePluginOptions: {},
}));
vi.mock("@/lib/entitlements/subject", () => ({
	resolveBillingSubject: async () => ({
		customerType: "user",
		referenceId: "user-1",
		chargebeeCustomerId: mocks.chargebeeCustomerId,
	}),
}));
vi.mock("@/lib/entitlements/sync", () => ({
	syncSubscriptionEntitlements: mocks.syncEntitlements,
}));

import { syncSignupBilling } from "./signup-sync";

const session = { user: { id: "user-1" }, session: {} } as unknown as Session;
const live = {
	subscription: { id: "sub-free", status: "active" },
	customer: { id: "cust-1" },
};

describe("syncSignupBilling", () => {
	beforeEach(() => {
		mocks.chargebeeCustomerId = "cust-1";
		mocks.list.mockReset();
		mocks.list.mockResolvedValue({ list: [live] });
		mocks.process.mockClear();
		mocks.syncEntitlements.mockClear();
	});

	it("mirrors the live subscription and fetches its entitlements", async () => {
		await syncSignupBilling(session);

		expect(mocks.list).toHaveBeenCalledWith(
			expect.objectContaining({ customer_id: { is: "cust-1" }, limit: 1 }),
		);
		expect(mocks.process).toHaveBeenCalledWith(
			expect.objectContaining({
				event_type: "subscription_created",
				content: live,
			}),
		);
		expect(mocks.syncEntitlements).toHaveBeenCalledWith("sub-free", {
			trigger: "signup",
		});
	});

	it("skips users without a Chargebee customer", async () => {
		mocks.chargebeeCustomerId = null;

		await syncSignupBilling(session);

		expect(mocks.list).not.toHaveBeenCalled();
		expect(mocks.syncEntitlements).not.toHaveBeenCalled();
	});

	it("skips customers without a live subscription", async () => {
		mocks.list.mockResolvedValue({ list: [] });

		await syncSignupBilling(session);

		expect(mocks.process).not.toHaveBeenCalled();
		expect(mocks.syncEntitlements).not.toHaveBeenCalled();
	});

	it("leaves the webhook path in charge when Chargebee fails", async () => {
		mocks.list.mockRejectedValue(new Error("chargebee down"));

		await expect(syncSignupBilling(session)).resolves.toBeUndefined();
		expect(mocks.syncEntitlements).not.toHaveBeenCalled();
	});
});
