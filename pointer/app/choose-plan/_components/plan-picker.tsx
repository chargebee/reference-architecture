"use client";

import Link from "next/link";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";
import { checkoutReturnUrls } from "@/lib/checkout-urls";
import {
  selfServicePlans,
  type SelfServicePlan,
} from "@/lib/self-service-plans";

type ActiveSubscription = {
  id: string;
  chargebeeSubscriptionId: string | null;
  itemPriceId?: string | null;
  status: string;
};

export function PlanPicker({
  mode,
  activeSubscription,
}: {
  mode: "choose" | "switch";
  activeSubscription: ActiveSubscription | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pendingPlanId, setPendingPlanId] = useState<string | null>(null);

  async function onSelectPlan(plan: SelfServicePlan) {
    if (
      activeSubscription?.itemPriceId &&
      activeSubscription.itemPriceId === plan.itemPriceId
    ) {
      return;
    }

    setError(null);
    setPendingPlanId(plan.id);

    const payload = {
      itemPriceId: plan.itemPriceId,
      ...checkoutReturnUrls(mode === "switch" ? "/" : "/choose-plan"),
    };

    // `subscription/update` resolves the record by its Chargebee id, not the
    // local subscription row id. Without a linked Chargebee subscription there
    // is nothing to switch, so fall back to opening a new checkout.
    const chargebeeSubscriptionId = activeSubscription?.chargebeeSubscriptionId;

    const { error: subscriptionError } =
      mode === "switch" && chargebeeSubscriptionId
        ? await authClient.subscription.update({
            ...payload,
            subscriptionId: chargebeeSubscriptionId,
          })
        : await authClient.subscription.create(payload);

    if (subscriptionError) {
      setPendingPlanId(null);
      setError(subscriptionError.message ?? "Unable to start checkout");
    }
  }

  return (
    <div>
      <div className="mb-10 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            {mode === "switch" ? "Switch your plan" : "Choose your plan"}
          </h1>
          <p className="mt-2 text-zinc-600 dark:text-zinc-400">
            {mode === "switch"
              ? "Pick a new plan. Chargebee will open a hosted page to confirm the change."
              : "Start with Free or upgrade now. Team and Enterprise plans are provisioned separately."}
          </p>
        </div>
        {mode === "switch" ? (
          <Link
            href="/"
            className="text-sm font-medium text-zinc-600 underline-offset-2 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            Back to Pointer
          </Link>
        ) : null}
      </div>

      {error ? (
        <p
          role="alert"
          className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        {selfServicePlans.map((plan) => {
          const isCurrent =
            activeSubscription?.itemPriceId === plan.itemPriceId;
          const isPending = pendingPlanId === plan.id;

          return (
            <div
              key={plan.id}
              className={`flex flex-col rounded-2xl border p-7 ${
                plan.featured
                  ? "border-[#6E56CF] bg-white shadow-[0_20px_60px_-30px_rgba(110,86,207,0.6)] dark:bg-zinc-950"
                  : "border-black/[.06] bg-white dark:border-white/[.08] dark:bg-zinc-950"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                  {plan.name}
                </h2>
                {isCurrent ? (
                  <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                    Current
                  </span>
                ) : plan.featured ? (
                  <span className="rounded-full bg-[#6E56CF] px-3 py-1 text-xs font-medium text-white">
                    Popular
                  </span>
                ) : null}
              </div>

              <div className="mt-4 flex items-baseline gap-1">
                <span className="text-4xl font-semibold text-zinc-900 dark:text-zinc-50">
                  {plan.priceLabel}
                </span>
                <span className="text-zinc-500">{plan.cadence}</span>
              </div>

              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                {plan.blurb}
              </p>

              <ul className="mt-6 flex flex-1 flex-col gap-3 text-sm">
                {plan.perks.map((perk) => (
                  <li key={perk} className="flex items-start gap-2">
                    <span className="mt-0.5 text-[#6E56CF]">✓</span>
                    <span className="text-zinc-700 dark:text-zinc-300">
                      {perk}
                    </span>
                  </li>
                ))}
              </ul>

              <button
                type="button"
                disabled={isCurrent || isPending || Boolean(pendingPlanId)}
                onClick={() => onSelectPlan(plan)}
                className={`mt-7 flex h-11 items-center justify-center rounded-full px-5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  plan.featured
                    ? "bg-[#6E56CF] text-white hover:bg-[#5a45b3]"
                    : "border border-black/[.1] text-zinc-900 hover:bg-black/[.04] dark:border-white/[.15] dark:text-zinc-100 dark:hover:bg-white/[.06]"
                }`}
              >
                {isCurrent
                  ? "Current plan"
                  : isPending
                    ? "Opening checkout…"
                    : mode === "switch"
                      ? `Switch to ${plan.name}`
                      : `Choose ${plan.name}`}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
