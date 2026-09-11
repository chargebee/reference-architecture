import type { Subscription } from "chargebee";
import { describe, expect, it, vi } from "vitest";

import { ensureFreeSubscription } from "./free-subscription";

type Client = Parameters<typeof ensureFreeSubscription>[0];

function clientWith(
	list: ReturnType<typeof vi.fn>,
	createWithItems: ReturnType<typeof vi.fn>,
): Client {
	return { subscription: { list, createWithItems } } as unknown as Client;
}

describe("ensureFreeSubscription", () => {
	it("keeps an existing live subscription", async () => {
		const subscription = {
			id: "sub-existing",
			status: "active",
		} as Subscription;
		const list = vi.fn(async () => ({
			list: [{ subscription }],
		}));
		const createWithItems = vi.fn();

		await expect(
			ensureFreeSubscription(clientWith(list, createWithItems), {
				customerId: "customer-1",
				userId: "user-1",
			}),
		).resolves.toEqual({ subscription, created: false });

		expect(list).toHaveBeenCalledWith({
			customer_id: { is: "customer-1" },
			status: {
				in: ["future", "in_trial", "active", "non_renewing", "paused"],
			},
			limit: 1,
		});
		expect(createWithItems).not.toHaveBeenCalled();
	});

	it("creates the free plan with a stable idempotency key", async () => {
		const subscription = {
			id: "sub-free",
			status: "active",
		} as Subscription;
		const list = vi.fn(async () => ({ list: [] }));
		const createWithItems = vi.fn(async () => ({ subscription }));

		await expect(
			ensureFreeSubscription(clientWith(list, createWithItems), {
				customerId: "customer-1",
				userId: "user-1",
			}),
		).resolves.toEqual({ subscription, created: true });

		expect(createWithItems).toHaveBeenCalledWith(
			"customer-1",
			{
				id: expect.stringMatching(/^pointer-free-[a-f0-9]{32}$/),
				subscription_items: [
					{ item_price_id: "plan-free-USD-Monthly", quantity: 1 },
				],
				meta_data: {
					userId: "user-1",
					customerType: "user",
					origin: "signup",
				},
			},
			{
				"chargebee-idempotency-key": expect.stringMatching(
					/^pointer-free-[a-f0-9]{32}$/,
				),
			},
		);
		const [, body, headers] = createWithItems.mock.calls[0] as unknown as [
			string,
			{ id: string },
			{ "chargebee-idempotency-key": string },
		];
		expect(body.id).toBe(headers["chargebee-idempotency-key"]);
	});
});
