import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { isAdminRequest } from "@/lib/admin";
import { auth } from "@/lib/auth";
import { FlowCanvas } from "./_components/FlowCanvas";

export default async function FlowPage() {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/sign-in?from=/flow");

  // /flow is an admin-only view. Non-admins are bounced to the dashboard.
  if (!(await isAdminRequest(requestHeaders))) redirect("/dashboard");

  return (
    <div className="flex h-screen w-full flex-col bg-zinc-50 dark:bg-black">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-3 dark:border-zinc-800 dark:bg-zinc-950">
        <div>
          <h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
            Pointer ↔ Chargebee flow
          </h1>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Live broadcast of internal events from the Redis stream.
          </p>
        </div>
        <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
          {session.user.email}
        </span>
      </header>
      <FlowCanvas />
    </div>
  );
}
