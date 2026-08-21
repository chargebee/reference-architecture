"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { authClient } from "@/lib/auth-client";
import { checkoutReturnUrls } from "@/lib/checkout-urls";
import type { SelfServicePlan } from "@/lib/self-service-plans";

const POLL_INTERVAL_MS = 1_500;
const POLL_ATTEMPTS = 40;

async function readyChargebeeSubscriptionId(): Promise<string | null> {
  const response = await fetch("/api/entitlements/status", {
    cache: "no-store",
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { subscriptionId?: unknown };
  return typeof body.subscriptionId === "string" ? body.subscriptionId : null;
}

export function AccountProvisioning({
  checkoutPlan,
}: {
  checkoutPlan?: SelfServicePlan;
}) {
  const router = useRouter();
  const [attempt, setAttempt] = useState(0);
  const [timedOut, setTimedOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkoutItemPriceId = checkoutPlan?.itemPriceId;

  useEffect(() => {
    let active = true;

    void (async () => {
      for (let index = 0; index < POLL_ATTEMPTS; index += 1) {
        try {
          const subscriptionId = await readyChargebeeSubscriptionId();
          if (subscriptionId) {
            if (!active) return;
            if (!checkoutItemPriceId) {
              router.replace("/");
              router.refresh();
              return;
            }

            // Every account starts on free, so buying a paid plan is a switch
            // on the existing subscription. A successful call hands the
            // browser to Chargebee's hosted page.
            const { error: checkoutError } =
              await authClient.subscription.update({
                subscriptionId,
                itemPriceId: checkoutItemPriceId,
                ...checkoutReturnUrls("/"),
              });

            if (!active) return;
            if (checkoutError) {
              setError(checkoutError.message ?? "Unable to open checkout");
            }
            return;
          }
        } catch {
          // The webhook worker or local mirror may still be starting.
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        if (!active) return;
      }
      if (active) setTimedOut(true);
    })();

    return () => {
      active = false;
    };
  }, [attempt, checkoutItemPriceId, router]);

  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-xl items-center px-6 py-16">
      <section
        aria-live="polite"
        className="w-full rounded-2xl border border-zinc-200 bg-white p-8 text-center shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
      >
        <div
          aria-hidden
          className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-violet-200 border-t-[#6E56CF] dark:border-violet-950 dark:border-t-violet-400"
        />
        <h1 className="mt-6 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          {checkoutPlan
            ? `Setting up ${checkoutPlan.name}`
            : "Setting up your free plan"}
        </h1>
        <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
          {checkoutPlan
            ? `Chargebee is creating your account. We'll open the ${checkoutPlan.name} checkout as soon as it is ready.`
            : "Chargebee is creating your subscription. Pointer will open as soon as its local record arrives; free-tier defaults apply while the entitlement snapshot finishes loading."}
        </p>

        {error ? (
          <div className="mt-6">
            <p
              role="alert"
              className="text-sm text-red-700 dark:text-red-300"
            >
              {error}
            </p>
            <Link
              href="/choose-plan"
              className="mt-3 inline-flex rounded-full bg-[#6E56CF] px-5 py-2 text-sm font-medium text-white hover:bg-[#5a45b3]"
            >
              Pick a plan
            </Link>
          </div>
        ) : null}

        {timedOut ? (
          <div className="mt-6">
            <p className="text-sm text-amber-700 dark:text-amber-300">
              Provisioning is taking longer than expected.
            </p>
            <button
              type="button"
              onClick={() => {
                setTimedOut(false);
                setAttempt((value) => value + 1);
              }}
              className="mt-3 rounded-full bg-[#6E56CF] px-5 py-2 text-sm font-medium text-white hover:bg-[#5a45b3]"
            >
              Try again
            </button>
          </div>
        ) : null}
      </section>
    </main>
  );
}
