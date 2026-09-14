import { headers } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import process from "node:process";

import { auth } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { syncSubscriptionEntitlements } from "@/lib/entitlements/sync";
import { resolveBillingSubject } from "@/lib/entitlements/subject";
import { chargebeeClient } from "@/plugins/chargebee-plugin";

function safeCallback(value: string | null): string {
	return value?.startsWith("/") && !value.startsWith("//") ? value : "/";
}

// Use BETTER_AUTH_URL as the redirect base so that redirects resolve to the
// public domain even when the app is behind a load balancer (request.url
// would carry the internal EC2 hostname in that case).
const appBase = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

export async function GET(request: NextRequest): Promise<Response> {
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session) {
		return NextResponse.redirect(new URL("/sign-in?from=/", appBase));
	}

	const callbackURL = safeCallback(
		request.nextUrl.searchParams.get("callbackURL"),
	);
	const subject = await resolveBillingSubject(session, {
		customerType: "user",
	});
	const requestedSubscriptionId =
		request.nextUrl.searchParams.get("subscriptionId");
	const pool = await getPool();
	const result = await pool.query<{
		id: string;
		chargebeeSubscriptionId: string | null;
	}>(
		`SELECT id, "chargebeeSubscriptionId"
       FROM subscription
      WHERE "referenceId" = $1
        AND ($2::text IS NULL OR id = $2)
      ORDER BY "periodStart" DESC NULLS LAST
      LIMIT 1`,
		[subject.referenceId, requestedSubscriptionId],
	);
	const local = result.rows[0];
	if (!local) {
		return new Response("Subscription not found", { status: 404 });
	}

	try {
		let chargebeeSubscriptionId = local.chargebeeSubscriptionId;
		if (!chargebeeSubscriptionId && subject.chargebeeCustomerId) {
			const subscriptions = await chargebeeClient.subscription.list({
				customer_id: { is: subject.chargebeeCustomerId },
				limit: 10,
			});
			const active = subscriptions.list
				.map((entry) => entry.subscription)
				.filter((subscription) =>
					["active", "in_trial", "non_renewing", "future"].includes(
						subscription.status ?? "",
					),
				)
				.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))[0];
			chargebeeSubscriptionId = active?.id ?? null;
			if (chargebeeSubscriptionId) {
				await pool.query(
					`UPDATE subscription
              SET "chargebeeSubscriptionId" = $1
            WHERE id = $2 AND "referenceId" = $3
              AND "chargebeeSubscriptionId" IS NULL`,
					[chargebeeSubscriptionId, local.id, subject.referenceId],
				);
			}
		}

		if (chargebeeSubscriptionId) {
			await syncSubscriptionEntitlements(chargebeeSubscriptionId, {
				trigger: "checkout",
			});
		}
	} catch (error) {
		// The webhook worker remains the correctness path. Do not strand a paid
		// customer on the callback if the optimistic refresh is temporarily down.
		console.error("[entitlements] checkout refresh failed", error);
	}

	return NextResponse.redirect(new URL(callbackURL, appBase));
}
