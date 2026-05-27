import { headers } from "next/headers";
import Image from "next/image";
import Link from "next/link";

import { auth } from "@/lib/auth";

import { SignOutButton } from "./_components/sign-out-button";

export default async function Home() {
  const session = await auth.api.getSession({ headers: await headers() });

  return (
    <div className="flex flex-col flex-1 items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex flex-1 w-full max-w-3xl flex-col items-center justify-between py-32 px-16 bg-white dark:bg-black sm:items-start">
        <Image
          className="dark:invert"
          src="/next.svg"
          alt="Next.js logo"
          width={100}
          height={20}
          priority
        />
        <div className="flex flex-col items-center gap-6 text-center sm:items-start sm:text-left">
          <h1 className="max-w-xs text-3xl font-semibold leading-10 tracking-tight text-black dark:text-zinc-50">
            {session
              ? `Welcome back, ${session.user.name || session.user.email}.`
              : "Pointer — Chargebee Reference Architecture"}
          </h1>
          <p className="max-w-md text-lg leading-8 text-zinc-600 dark:text-zinc-400">
            {session ? (
              <>
                You&apos;re signed in as{" "}
                <span className="font-medium text-zinc-900 dark:text-zinc-100">
                  {session.user.email}
                </span>
                {session.user.emailVerified ? null : (
                  <>
                    {" "}
                    (
                    <Link
                      href="/verify-email"
                      className="underline underline-offset-2"
                    >
                      verify email
                    </Link>
                    )
                  </>
                )}
                . Head to the dashboard to see a protected route.
              </>
            ) : (
              <>
                Better Auth is wired up. Create an account or sign in to see
                the protected dashboard.
              </>
            )}
          </p>
        </div>
        <div className="flex flex-col gap-4 text-base font-medium sm:flex-row">
          {session ? (
            <>
              <Link
                className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-foreground px-5 text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc] md:w-[158px]"
                href="/dashboard"
              >
                Dashboard
              </Link>
              <SignOutButton />
            </>
          ) : (
            <>
              <Link
                className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-foreground px-5 text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc] md:w-[158px]"
                href="/sign-in"
              >
                Sign in
              </Link>
              <Link
                className="flex h-12 w-full items-center justify-center rounded-full border border-solid border-black/[.08] px-5 transition-colors hover:border-transparent hover:bg-black/[.04] dark:border-white/[.145] dark:hover:bg-[#1a1a1a] md:w-[158px]"
                href="/sign-up"
              >
                Create account
              </Link>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
