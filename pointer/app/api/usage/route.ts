import { type NextRequest } from "next/server";

import { auth } from "@/lib/auth";
import { resolveEntitlements } from "@/lib/entitlements/features";
import { getUsageSnapshot } from "@/lib/entitlements/gate";
import { getEntitlementSnapshotDiagnostics } from "@/lib/entitlements/postgres-store";
import { resolveEntitlementSubject } from "@/lib/entitlements/subject";

export async function GET(request: NextRequest): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return Response.json(
      { error: "unauthenticated", message: "Sign in to view usage" },
      { status: 401 },
    );
  }
  const subject = await resolveEntitlementSubject(session, {
    customerType: "user",
  });
  if (!subject) {
    return Response.json(
      {
        error: "no_subscription",
        message: "Choose a plan to view usage",
        upgradeHint: { action: "upgrade", href: "/choose-plan" },
      },
      { status: 403 },
    );
  }

  try {
    // A pending snapshot is not an error: the response reports free-tier limits
    // and `entitlementsPending` so the client can re-check shortly.
    const entitlements = await resolveEntitlements(subject);
    const [usage, entitlementSnapshot] = await Promise.all([
      getUsageSnapshot(subject, entitlements),
      getEntitlementSnapshotDiagnostics(subject.chargebeeSubscriptionId),
    ]);
    return Response.json({ ...usage, entitlementSnapshot });
  } catch (error) {
    console.error("[usage] entitlement enforcement failed", error);
    return Response.json(
      {
        error: "enforcement_unavailable",
        message: "Local entitlement enforcement is temporarily unavailable",
      },
      { status: 503 },
    );
  }
}
