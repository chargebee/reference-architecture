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

import { chargebeeClient, chargebeePluginOptions } from "@/plugins/chargebee-plugin";
import { getPool } from "@/lib/db";
import { emit } from "@/lib/events/emit";
import { webhookCorrectnessPlugin } from "@/plugins/webhook-plugin";

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
    minPasswordLength: 1,
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
          await emit("app.user_created", {
            userId: user.id,
            email: user.email,
            name: user.name,
          });
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
            await emit("chargebee.customer_created", {
              customerId: customer.id,
              userId: user.id,
              email: user.email,
              customerType: "user",
              origin: "databaseHook",
              reused: Boolean(found),
            });
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
      adminUserIds: (process.env.ADMIN_USER_IDS || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    }),
    twoFactor(),
    bearer(),
    chargebee(chargebeePluginOptions),
    // Registers the chargebee_resource_version table so the Better Auth CLI
    // migrate/generate manages it alongside the core + plugin schema.
    webhookCorrectnessPlugin,
    // nextCookies must be the LAST plugin so it can wrap responses from server actions.
    nextCookies(),
  ],
  advanced: {
    useSecureCookies: process.env.NODE_ENV === "production",
  },
});

export type Session = typeof auth.$Infer.Session;
