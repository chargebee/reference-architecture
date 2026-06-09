import { chargebeeClient } from "@chargebee/better-auth/client";
import { createAuthClient } from "better-auth/react";
import {
  adminClient,
  organizationClient,
  twoFactorClient,
} from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL:
    process.env.NEXT_PUBLIC_BETTER_AUTH_URL ?? "http://localhost:3000",
  plugins: [
    organizationClient(),
    adminClient(),
    twoFactorClient(),
    chargebeeClient({ subscription: true }),
  ],
});

export const { signIn, signUp, signOut, useSession, getSession } = authClient;
