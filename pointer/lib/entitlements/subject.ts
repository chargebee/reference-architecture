import type { Session } from "@/lib/auth";
import { getPool } from "@/lib/db";
import {
  getActiveSubscriptionForReference,
  type UserSubscription,
} from "@/lib/subscriptions";

export type CustomerType = "user" | "organization";

export type BillingSubject = {
  customerType: CustomerType;
  referenceId: string;
  chargebeeCustomerId: string | null;
};

export type EntitlementSubject = BillingSubject & {
  subscription: UserSubscription;
  chargebeeSubscriptionId: string;
};

type ResolveSubjectOptions = {
  customerType?: CustomerType;
  referenceId?: string;
};

export async function resolveBillingSubject(
  session: Session,
  options: ResolveSubjectOptions = {},
): Promise<BillingSubject> {
  const activeOrganizationId = (
    session.session as typeof session.session & {
      activeOrganizationId?: string | null;
    }
  ).activeOrganizationId;
  const customerType =
    options.customerType ??
    (activeOrganizationId ? "organization" : "user");
  const referenceId =
    options.referenceId ??
    (customerType === "organization" ? activeOrganizationId : session.user.id);

  if (!referenceId) {
    throw new Error("No active organization is available for entitlement checks");
  }

  const pool = await getPool();
  if (customerType === "organization") {
    const result = await pool.query<{ chargebeeCustomerId: string | null }>(
      `SELECT o."chargebeeCustomerId"
         FROM organization o
         JOIN member m ON m."organizationId" = o.id
        WHERE o.id = $1 AND m."userId" = $2
        LIMIT 1`,
      [referenceId, session.user.id],
    );
    if (!result.rows[0]) {
      throw new Error("The user is not a member of the billing organization");
    }
    return {
      customerType,
      referenceId,
      chargebeeCustomerId: result.rows[0].chargebeeCustomerId,
    };
  }

  if (referenceId !== session.user.id) {
    throw new Error("A user billing subject cannot reference another user");
  }
  const result = await pool.query<{ chargebeeCustomerId: string | null }>(
    `SELECT "chargebeeCustomerId" FROM "user" WHERE id = $1 LIMIT 1`,
    [referenceId],
  );
  return {
    customerType,
    referenceId,
    chargebeeCustomerId: result.rows[0]?.chargebeeCustomerId ?? null,
  };
}

export async function resolveEntitlementSubject(
  session: Session,
  options: ResolveSubjectOptions = {},
): Promise<EntitlementSubject | null> {
  const subject = await resolveBillingSubject(session, options);
  const subscription = await getActiveSubscriptionForReference(
    subject.referenceId,
  );
  if (!subscription?.chargebeeSubscriptionId) return null;
  return {
    ...subject,
    subscription,
    chargebeeSubscriptionId: subscription.chargebeeSubscriptionId,
  };
}
