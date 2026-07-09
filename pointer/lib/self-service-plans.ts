import {
  itemPriceIdFor,
  planLimits,
  plans,
  type PlanId,
} from "@/scripts/catalog";

/** Personal plans users can pick at sign-up or switch to from the dashboard. */
export const selfServicePlanIds = [
  "plan-free",
  "plan-pro",
  "plan-max",
] as const satisfies readonly PlanId[];

export type SelfServicePlanId = (typeof selfServicePlanIds)[number];

export type SelfServicePlan = {
  id: SelfServicePlanId;
  name: string;
  itemPriceId: string;
  priceLabel: string;
  cadence: string;
  blurb: string;
  perks: string[];
  featured?: boolean;
};

function formatTokens(value: number | "unlimited"): string {
  if (value === "unlimited") return "Unlimited tokens";
  if (value >= 1_000_000) return `${value / 1_000_000}M tokens / day`;
  if (value >= 1_000) return `${value / 1_000}K tokens / day`;
  return `${value.toLocaleString()} tokens / day`;
}

function formatCredits(value: number | "unlimited"): string {
  if (value === "unlimited") return "Unlimited credits / month";
  if (value === 0) return "No monthly credits";
  return `${value.toLocaleString()} credits / month`;
}

const modelLabels = {
  basic: "Basic models",
  advanced: "Advanced models",
  premium: "Premium models",
  enterprise: "Enterprise models",
} as const;

function perksForPlan(planId: SelfServicePlanId): string[] {
  const limits = planLimits[planId];
  const perks = [
    formatTokens(limits.inputTokensDaily),
    formatCredits(limits.creditsMonthly),
    modelLabels[limits.models],
    `${limits.apiRatePerMinute} API requests / min`,
  ];
  return perks;
}

const blurbs: Record<SelfServicePlanId, string> = {
  "plan-free": "For trying Pointer on everyday questions.",
  "plan-pro": "For professionals who live in AI all day.",
  "plan-max": "For power users who need the highest limits.",
};

export const selfServicePlans: SelfServicePlan[] = selfServicePlanIds.map(
  (planId) => {
    const catalogPlan = plans.find((plan) => plan.id === planId)!;
    const priceUsd = catalogPlan.priceUSDMonthlyCents / 100;
    return {
      id: planId,
      name: catalogPlan.name,
      itemPriceId: itemPriceIdFor(planId),
      priceLabel: priceUsd === 0 ? "$0" : `$${priceUsd}`,
      cadence: "/mo",
      blurb: blurbs[planId],
      perks: perksForPlan(planId),
      featured: planId === "plan-pro",
    };
  },
);

export function planNameFromItemPriceId(
  itemPriceId: string | null | undefined,
): string | undefined {
  if (!itemPriceId) return undefined;
  return selfServicePlans.find((plan) => plan.itemPriceId === itemPriceId)
    ?.name;
}
