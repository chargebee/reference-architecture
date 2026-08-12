import { createHash } from "node:crypto";

import type Chargebee from "chargebee";
import type { Subscription } from "chargebee";

import { itemPriceIdFor } from "@/scripts/catalog";

const LIVE_SUBSCRIPTION_STATUSES = [
  "future",
  "in_trial",
  "active",
  "non_renewing",
  "paused",
] as const;

type SubscriptionClient = Pick<
  InstanceType<typeof Chargebee>,
  "subscription"
>;

export type FreeSubscriptionResult = {
  subscription: Subscription;
  created: boolean;
};

function signupSubscriptionId(userId: string): string {
  const digest = createHash("sha256").update(userId).digest("hex").slice(0, 32);
  return `pointer-free-${digest}`;
}

/**
 * Gives a newly-created personal customer an immediately active free plan.
 *
 * Listing first prevents a recreated account/customer from receiving a second
 * live subscription. The deterministic subscription id and Chargebee
 * idempotency key also make concurrent or retried user-create hooks safe.
 * Chargebee's subscription webhook remains responsible for the local mirror.
 */
export async function ensureFreeSubscription(
  client: SubscriptionClient,
  input: { customerId: string; userId: string },
): Promise<FreeSubscriptionResult> {
  const existing = await client.subscription.list({
    customer_id: { is: input.customerId },
    status: { in: [...LIVE_SUBSCRIPTION_STATUSES] },
    limit: 1,
  });
  const current = existing.list?.[0]?.subscription;
  if (current) return { subscription: current, created: false };

  const id = signupSubscriptionId(input.userId);
  const created = await client.subscription.createWithItems(
    input.customerId,
    {
      id,
      subscription_items: [
        {
          item_price_id: itemPriceIdFor("plan-free"),
          quantity: 1,
        },
      ],
      meta_data: {
        userId: input.userId,
        customerType: "user",
        origin: "signup",
      },
    },
    { "chargebee-idempotency-key": id },
  );

  return { subscription: created.subscription, created: true };
}
