import { headers } from "next/headers";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { findSelfServicePlan, selfServicePlans } from "@/lib/self-service-plans";
import { getActiveUserSubscription } from "@/lib/subscriptions";

import { AccountProvisioning } from "./_components/account-provisioning";
import { AppHeader } from "./_components/app-header";
import { AskPanel } from "./_components/ask-panel";

export default async function Home({ searchParams }: PageProps<"/">) {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return <MarketingHome />;

  // Signing up provisions a free subscription in the background, so a brand
  // new account lands here before its local record exists.
  const { provisioning, plan } = await searchParams;
  const subscription = await getActiveUserSubscription(session.user.id);
  const requestedPlan = findSelfServicePlan(plan);

  // A paid plan picked on the pricing page can only go to checkout once that
  // free subscription exists, because upgrading is a switch on an existing
  // Chargebee subscription.
  if (
    requestedPlan?.paid &&
    subscription?.itemPriceId !== requestedPlan.itemPriceId
  ) {
    return <AccountProvisioning checkoutPlan={requestedPlan} />;
  }

  if (!subscription) {
    if (provisioning === "1") return <AccountProvisioning />;
    redirect("/choose-plan");
  }

  return <SignedInHome />;
}

function SignedInHome() {
  return (
    <div className="flex flex-1 flex-col bg-zinc-50 font-sans text-zinc-900 dark:bg-black dark:text-zinc-50">
      <AppHeader />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10 sm:py-16">
        <AskPanel />
      </main>

      <footer className="mx-auto w-full max-w-3xl px-6 pb-10 text-center text-xs text-zinc-400">
        Pointer is a demonstration of the Chargebee Reference Architecture, not
        a real product.
      </footer>
    </div>
  );
}

function MarketingHome() {
  return (
    <div className="flex flex-1 flex-col bg-zinc-50 font-sans text-zinc-900 dark:bg-black dark:text-zinc-50">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        <Image
          src="/pointer-lockup-white.svg"
          alt="Pointer"
          width={140}
          height={40}
          priority
        />
        <nav className="flex items-center gap-3 text-sm font-medium">
          <Link
            href="/sign-in"
            className="rounded-full px-4 py-2 text-zinc-700 transition-colors hover:bg-black/[.05] dark:text-zinc-300 dark:hover:bg-white/[.06]"
          >
            Sign in
          </Link>
          <Link
            href="/sign-up"
            className="rounded-full bg-[#6E56CF] px-5 py-2 text-white transition-colors hover:bg-[#5a45b3]"
          >
            Get started
          </Link>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6">
        <section className="flex flex-col items-center gap-10 pt-10 pb-20 text-center">
          <div className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-[#6E56CF]/20 bg-[#6E56CF]/[.06] px-4 py-3 text-lg text-zinc-700 sm:flex-row dark:text-zinc-300">
            <span>
              <span className="font-medium text-[#6E56CF]">Pointer</span>{" "}
              is a demonstration of the Chargebee Reference Architecture, not a real product!
            </span>
            <a
              href="https://github.com/chargebee/reference-architecture"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 font-medium text-[#6E56CF] underline-offset-2 hover:underline"
            >
              <svg
                viewBox="0 0 16 16"
                width={16}
                height={16}
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
              </svg>
              View on GitHub
            </a>
          </div>
          <div className="w-full overflow-hidden rounded-2xl border border-black/[.06] shadow-[0_30px_80px_-40px_rgba(110,86,207,0.45)] dark:border-white/[.08]">
            <Image
              src="/pointer-hero-banner.svg"
              alt="Pointer — ask anything, get pointed straight to the answer"
              width={1200}
              height={420}
              priority
              className="h-auto w-full"
            />
          </div>
        </section>

        <section className="pb-24">
          <div className="mb-10 text-center">
            <h2 className="text-3xl font-semibold tracking-tight">
              Pricing that points your way
            </h2>
            <p className="mt-3 text-zinc-600 dark:text-zinc-400">
              Start free. Upgrade when you&apos;re ready for unlimited answers.
            </p>
          </div>
          <div className="grid gap-6 lg:grid-cols-3">
            {selfServicePlans.map((plan) => (
              <div
                key={plan.id}
                className={`flex flex-col rounded-2xl border p-7 ${
                  plan.featured
                    ? "border-[#6E56CF] bg-white shadow-[0_20px_60px_-30px_rgba(110,86,207,0.6)] dark:bg-zinc-950"
                    : "border-black/[.06] bg-white dark:border-white/[.08] dark:bg-zinc-950"
                }`}
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold">{plan.name}</h3>
                  {plan.featured && (
                    <span className="rounded-full bg-[#6E56CF] px-3 py-1 text-xs font-medium text-white">
                      Popular
                    </span>
                  )}
                </div>
                <div className="mt-4 flex items-baseline gap-1">
                  <span className="text-4xl font-semibold">
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
                <Link
                  href={`/sign-up?plan=${plan.id}`}
                  className={`mt-7 flex h-11 items-center justify-center rounded-full px-5 text-sm font-medium transition-colors ${
                    plan.featured
                      ? "bg-[#6E56CF] text-white hover:bg-[#5a45b3]"
                      : "border border-black/[.1] hover:bg-black/[.04] dark:border-white/[.15] dark:hover:bg-white/[.06]"
                  }`}
                >
                  Choose {plan.name}
                </Link>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-black/[.06] dark:border-white/[.08]">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 text-sm text-zinc-500 sm:flex-row">
          <div className="flex items-center gap-2">
            <Image
              src="/pointer-favicon.svg"
              alt=""
              width={20}
              height={20}
            />
            <span>© {new Date().getFullYear()} Pointer. All rights reserved.</span>
          </div>
          <span>Ask anything — get pointed straight to the answer.</span>
        </div>
      </footer>
    </div>
  );
}
