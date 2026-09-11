import type { NextRequest } from "next/server";

import { auth } from "@/lib/auth";
import { getEntitlementSnapshotDiagnostics } from "@/lib/entitlements/postgres-store";
import { resolveEntitlementSubject } from "@/lib/entitlements/subject";

/**
 * Readiness probe for the local entitlement mirror. The dashboard polls this
 * while a snapshot is still loading so it can reload once the subscriber's real
 * plan replaces the free-tier defaults.
 */
export async function GET(request: NextRequest): Promise<Response> {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session) {
		return Response.json(
			{ error: "unauthenticated", message: "Sign in to read entitlements" },
			{ status: 401 },
		);
	}

	const subject = await resolveEntitlementSubject(session, {
		customerType: "user",
	});
	if (!subject) {
		return Response.json({ ready: false, reason: "no_subscription" });
	}

	const snapshot = await getEntitlementSnapshotDiagnostics(
		subject.chargebeeSubscriptionId,
	);
	return Response.json({
		ready: snapshot !== null,
		subscriptionId: subject.chargebeeSubscriptionId,
		snapshot,
	});
}
