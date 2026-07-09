import { getPool } from "@/lib/db";
import { itemPriceIdFor, planLimits, type PlanId } from "@/scripts/catalog";

export type UserSubscription = {
  id: string;
  referenceId: string;
  chargebeeSubscriptionId: string | null;
  status: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  itemPriceId: string | null;
  planId: PlanId | null;
  limits: (typeof planLimits)[PlanId] | null;
};

const ACTIVE_STATUSES = new Set(["active", "in_trial", "non_renewing"]);

function planIdFromItemPriceId(itemPriceId: string | null): PlanId | null {
  if (!itemPriceId) return null;
  const suffix = "-USD-Monthly";
  if (!itemPriceId.endsWith(suffix)) return null;
  const planId = itemPriceId.slice(0, -suffix.length);
  if (planId in planLimits) return planId as PlanId;
  return null;
}

export async function getActiveUserSubscription(
  userId: string,
): Promise<UserSubscription | null> {
  const pool = await getPool();
  const { rows } = await pool.query<{
    id: string;
    referenceId: string;
    chargebeeSubscriptionId: string | null;
    status: string;
    periodStart: Date | null;
    periodEnd: Date | null;
    itemPriceId: string | null;
  }>(
    `SELECT s.id,
            s."referenceId",
            s."chargebeeSubscriptionId",
            s.status,
            s."periodStart",
            s."periodEnd",
            si."itemPriceId"
       FROM subscription s
       LEFT JOIN "subscriptionItem" si
         ON si."subscriptionId" = s.id
        AND si."itemType" = 'plan'
      WHERE s."referenceId" = $1
        AND s.status = ANY($2)
      ORDER BY s."periodStart" DESC NULLS LAST
      LIMIT 1`,
    [userId, Array.from(ACTIVE_STATUSES)],
  );

  const active = rows[0];
  if (!active) return null;

  const planId = planIdFromItemPriceId(active.itemPriceId);
  return {
    ...active,
    planId,
    limits: planId ? planLimits[planId] : null,
  };
}

export function itemPriceIdForPlanId(planId: PlanId): string {
  return itemPriceIdFor(planId);
}
