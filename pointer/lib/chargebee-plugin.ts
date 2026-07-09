import type { ChargebeeOptions } from "@chargebee/better-auth";
import Chargebee from "chargebee";

import { emit } from "@/lib/events/emit";
import { getPool } from "@/lib/db";
import {
  itemPriceIdFor,
  planLimits,
  type PlanId,
} from "@/scripts/catalog";
import { chargebeeWebhookEventBus } from "./webhooks";

export const chargebeeClient = new Chargebee({
  apiKey: process.env.CHARGEBEE_API_KEY ?? "",
  site: process.env.CHARGEBEE_SITE ?? "",
});

/**
 * Chargebee plugin options shared by Better Auth and the webhook worker.
 *
 * When `webhookEventBus` is set, the HTTP webhook endpoint only validates,
 * parses, and enqueues events. DB sync runs asynchronously in the worker via
 * `createChargebeeWebhookProcessor`. The event bus `publish` hook also emits
 * `chargebee.webhook_received` for the live /flow visualization.
 */
export const chargebeePluginOptions = {
  chargebeeClient,
  createCustomerOnSignUp: true,
  getCustomerCreateParams: (user) => {
    const [firstName, ...rest] = (user.name ?? "").trim().split(/\s+/);
    return {
      first_name: firstName || undefined,
      last_name: rest.join(" ") || undefined,
    };
  },
  onCustomerCreate: async ({ chargebeeCustomer, user }) => {
    console.log(
      `[chargebee] created customer ${chargebeeCustomer.id} for user ${user.id} (${user.email})`,
    );
    await emit("chargebee.customer_created", {
      customerId: chargebeeCustomer.id,
      userId: user.id,
      email: user.email,
      customerType: "user",
      origin: "plugin",
    });
  },
  webhookUsername: process.env.CHARGEBEE_WEBHOOK_USERNAME,
  webhookPassword: process.env.CHARGEBEE_WEBHOOK_PASSWORD,
  webhookEventBus: chargebeeWebhookEventBus,

  // Let Team plans bill against the organization (rather than the user)
  // by passing customerType: "organization" + referenceId: orgId at
  // subscription.create time. This auto-creates a Chargebee customer
  // for the org on first subscribe.
  organization: { enabled: true },

  subscription: {
    enabled: true,
    // Sign-up does not require email verification in this app, so keep
    // subscription flows aligned with the auth configuration.
    requireEmailVerification: false,
    // plan-enterprise is intentionally omitted from the self-service plan
    // list — Enterprise is sales-led with negotiated contracts; the
    // catalog still seeds it so contracts can be wired in the Chargebee
    // dashboard with subscription-level Entitlement Overrides.
    plans: (
      ["plan-free", "plan-pro", "plan-max", "plan-team"] as const satisfies readonly PlanId[]
    ).map((planId) => ({
      name: planId.replace(/^plan-/, ""),
      itemPriceId: itemPriceIdFor(planId),
      type: "plan" as const,
      limits: planLimits[planId] as unknown as Record<string, unknown>,
    })),
    // For Team plans (customerType: "organization") only the org owner
    // can manage billing. Personal subscriptions use the user as the
    // reference and skip this hook.
    authorizeReference: async ({ user, referenceId, action }) => {
      if (
        action === "create-subscription" ||
        action === "upgrade-subscription" ||
        action === "cancel-subscription" ||
        action === "restore-subscription" ||
        action === "billing-portal"
      ) {
        const pool = await getPool();
        const { rows } = await pool.query<{ role: string }>(
          `SELECT role FROM "member"
              WHERE "organizationId" = $1 AND "userId" = $2`,
          [referenceId, user.id],
        );
        return rows[0]?.role === "owner";
      }
      return true;
    },
    onSubscriptionCreated: async ({ subscription, plan }) => {
      console.log(
        `[chargebee] subscription ${subscription.id} created on plan ${plan?.name ?? "?"} for reference ${subscription.referenceId}`,
      );
    },
  },
} satisfies ChargebeeOptions;
