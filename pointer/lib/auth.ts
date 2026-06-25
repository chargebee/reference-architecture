import { chargebee } from "@chargebee/better-auth";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { PostgresDialect } from "kysely";
import {
  admin,
  bearer,
  organization,
  twoFactor,
} from "better-auth/plugins";
import Chargebee from "chargebee";

import { getPool } from "@/lib/db";
import { registerChargebeeWebhookForwarder } from "@/lib/webhooks";
import {
  itemPriceIdFor,
  planLimits,
  type PlanId,
} from "@/scripts/catalog";

const chargebeeClient = new Chargebee({
  apiKey: process.env.CHARGEBEE_API_KEY ?? "",
  site: process.env.CHARGEBEE_SITE ?? "",
});

const baseURL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

export const auth = betterAuth({
  baseURL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: {
    dialect: new PostgresDialect({ pool: getPool }), // called lazily on 1st query
    type: "postgres",
  },
  // The Chargebee plugin only adds `chargebeeCustomerId` to the `user` table
  // when `organization.enabled` is false. We enable both (Personal accounts
  // bill against the user; Team accounts bill against the org), so we have
  // to register the column ourselves. `input: false` keeps it out of the
  // sign-up payload — only Better Auth/the plugin write to it.
  user: {
    additionalFields: {
      chargebeeCustomerId: {
        type: "string",
        required: false,
        input: false,
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    sendResetPassword: async ({ user, url }) => {
      console.log(
        `[mock-email] password reset for ${user.email}\n  -> ${url}`,
      );
    },
  },
  // The Chargebee plugin's built-in user-create hook short-circuits when
  // `organization.enabled` is true (it assumes orgs are the only billing
  // subject). We need both: Personal accounts bill against the user, Team
  // accounts bill against the org. Mirror the plugin's customer-create
  // logic here so personal users still get a Chargebee customer at sign-up.
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          const pool = await getPool();
          try {
            const existing = await chargebeeClient.customer.list({
              email: { is: user.email },
              limit: 1,
            });
            const found = existing.list?.[0]?.customer;
            const [firstName, ...rest] = (user.name ?? "")
              .trim()
              .split(/\s+/);
            const customer =
              found ??
              (
                await chargebeeClient.customer.create({
                  email: user.email,
                  first_name: firstName || undefined,
                  last_name: rest.join(" ") || undefined,
                  meta_data: { userId: user.id, customerType: "user" },
                })
              ).customer;

            await pool.query(
              `UPDATE "user" SET "chargebeeCustomerId" = $1 WHERE id = $2`,
              [customer.id, user.id],
            );
            console.log(
              `[chargebee] linked customer ${customer.id} to user ${user.id} (${user.email})`,
            );
          } catch (err) {
            console.error(
              `[chargebee] failed to create customer for user ${user.id}:`,
              err,
            );
          }
        },
      },
    },
  },
  emailVerification: {
    sendOnSignUp: false,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      console.log(
        `[mock-email] verify email for ${user.email}\n  -> ${url}`,
      );
    },
  },
  plugins: [
    organization(),
    admin({
      adminUserIds: [],
    }),
    twoFactor(),
    bearer(),
    chargebee({
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
      },
      webhookUsername: process.env.CHARGEBEE_WEBHOOK_USERNAME,
      webhookPassword: process.env.CHARGEBEE_WEBHOOK_PASSWORD,
      webhookHandler(handler) {
        registerChargebeeWebhookForwarder(handler);
      },

      // Let Team plans bill against the organization (rather than the user)
      // by passing customerType: "organization" + referenceId: orgId at
      // subscription.create time. This auto-creates a Chargebee customer
      // for the org on first subscribe.
      organization: { enabled: true },

      subscription: {
        enabled: true,
        requireEmailVerification: true,
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
    }),
    // nextCookies must be the LAST plugin so it can wrap responses from server actions.
    nextCookies(),
  ],
  advanced: {
    useSecureCookies: process.env.NODE_ENV === "production",
  },
});

export type Session = typeof auth.$Infer.Session;
