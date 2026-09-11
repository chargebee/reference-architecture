import { getPool } from "@/lib/db";
import { itemPriceIdFor, planLimits, type PlanId } from "@/scripts/catalog";

export type UserSubscription = {
	id: string;
	referenceId: string;
	chargebeeSubscriptionId: string | null;
	status: string;
	periodStart: Date | null;
	periodEnd: Date | null;
	seats: number | null;
	planQuantity: number;
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
	return getActiveSubscriptionForReference(userId);
}

export async function getActiveSubscriptionForReference(
	referenceId: string,
): Promise<UserSubscription | null> {
	const pool = await getPool();
	const { rows } = await pool.query<{
		id: string;
		referenceId: string;
		chargebeeSubscriptionId: string | null;
		status: string;
		periodStart: Date | null;
		periodEnd: Date | null;
		seats: number | null;
		planQuantity: number | null;
		itemPriceId: string | null;
	}>(
		`SELECT s.id,
            s."referenceId",
            s."chargebeeSubscriptionId",
            s.status,
            s."periodStart",
            s."periodEnd",
            s.seats,
            si.quantity AS "planQuantity",
            si."itemPriceId"
       FROM subscription s
       LEFT JOIN "subscriptionItem" si
         ON si."subscriptionId" = s.id
        AND si."itemType" = 'plan'
      WHERE s."referenceId" = $1
        AND s.status = ANY($2)
      ORDER BY s."periodStart" DESC NULLS LAST
      LIMIT 1`,
		[referenceId, Array.from(ACTIVE_STATUSES)],
	);

	const active = rows[0];
	if (!active) return null;

	const planId = planIdFromItemPriceId(active.itemPriceId);
	return {
		...active,
		planQuantity: active.planQuantity ?? active.seats ?? 1,
		planId,
		limits: planId ? planLimits[planId] : null,
	};
}

export function itemPriceIdForPlanId(planId: PlanId): string {
	return itemPriceIdFor(planId);
}
