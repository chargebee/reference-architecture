"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import type { UsageSnapshot } from "@/lib/entitlements/gate";

type ApiError = {
  error: string;
  message: string;
  retryAfterSeconds?: number;
  upgradeHint?: { action: string; href: string };
};

const STATUS_POLL_MS = 2_000;
const STATUS_POLL_ATTEMPTS = 15;

type GenerateResult = {
  output: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    creditsConsumed: number;
    source: "plan_quota" | "credits";
  };
  limits: UsageSnapshot;
};

function formatLimit(value: number | "unlimited"): string {
  return value === "unlimited" ? "Unlimited" : value.toLocaleString();
}

async function fetchUsage(): Promise<UsageSnapshot> {
  const response = await fetch("/api/usage", { cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw body;
  return body as UsageSnapshot;
}

/** Polls the mirror until the background Chargebee refresh has landed. */
async function waitForEntitlements(active: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < STATUS_POLL_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_MS));
    if (!active()) return false;
    try {
      const response = await fetch("/api/entitlements/status", {
        cache: "no-store",
      });
      if (!response.ok) continue;
      const body = (await response.json()) as { ready: boolean };
      if (body.ready) return true;
    } catch {
      // Keep polling; the refresh is retried on the next request anyway.
    }
  }
  return false;
}

function Meter({
  label,
  used,
  limit,
}: {
  label: string;
  used: number;
  limit: number | "unlimited";
}) {
  const percent =
    limit === "unlimited" || limit === 0
      ? 0
      : Math.min(100, Math.round((used / limit) * 100));
  const color =
    percent >= 100
      ? "bg-red-500"
      : percent >= 80
        ? "bg-amber-500"
        : "bg-[#6E56CF]";
  return (
    <div>
      <div className="flex justify-between gap-4 text-xs text-zinc-600 dark:text-zinc-400">
        <span>{label}</span>
        <span>
          {used.toLocaleString()} / {formatLimit(limit)}
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

export function GenerateDemo() {
  const router = useRouter();
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [prompt, setPrompt] = useState("Explain runtime entitlements in one paragraph.");
  const [model, setModel] = useState("");
  const [output, setOutput] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  const applyUsage = useCallback((snapshot: UsageSnapshot) => {
    setUsage(snapshot);
    setModel((current) =>
      snapshot.features.models.allowedModels.includes(current)
        ? current
        : (snapshot.features.models.allowedModels[0] ?? ""),
    );
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const snapshot = await fetchUsage();
        if (!active) return;
        applyUsage(snapshot);
        if (!snapshot.entitlementsPending) return;
        if (!(await waitForEntitlements(() => active))) return;
        applyUsage(await fetchUsage());
        // Server components read entitlements too, so refresh the whole route
        // once the subscriber's real plan replaces the free-tier defaults.
        router.refresh();
      } catch (reason) {
        if (!active) return;
        const apiError = reason as ApiError;
        setError({
          error: apiError.error ?? "usage_unavailable",
          message: apiError.message ?? "Unable to load usage",
        });
      }
    })();
    return () => {
      active = false;
    };
  }, [applyUsage, router]);

  async function generate() {
    setPending(true);
    setError(null);
    setOutput("");
    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, model, maxOutputTokens: 256 }),
      });
      const body = (await response.json()) as GenerateResult | ApiError;
      if (!response.ok) throw body;
      const result = body as GenerateResult;
      setOutput(result.output);
      applyUsage(result.limits);
    } catch (reason) {
      const apiError = reason as ApiError;
      setError({
        error: apiError.error ?? "request_failed",
        message: apiError.message ?? "Generation failed",
        retryAfterSeconds: apiError.retryAfterSeconds,
        upgradeHint: apiError.upgradeHint,
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="mt-8 rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            Entitlement-gated generation
          </h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Simulated generation uses live Chargebee entitlement snapshots and
            local Redis usage counters.
          </p>
        </div>
        {usage ? (
          <span className="rounded-full bg-violet-100 px-3 py-1 text-xs font-medium text-violet-800 dark:bg-violet-950 dark:text-violet-300">
            {usage.features.models.tier} models
          </span>
        ) : null}
      </div>

      {usage?.entitlementsPending ? (
        <div
          role="status"
          className="mt-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        >
          Loading your plan entitlements from Chargebee. Free-tier limits apply
          until they arrive, then this page refreshes automatically.
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {error.message}
          {error.retryAfterSeconds
            ? ` Try again in ${error.retryAfterSeconds}s.`
            : null}
          {error.upgradeHint ? (
            <Link
              href={error.upgradeHint.href}
              className="ml-2 font-medium underline"
            >
              View plans
            </Link>
          ) : null}
        </div>
      ) : null}

      <div className="mt-5 grid gap-4">
        <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Model
          <select
            value={model}
            onChange={(event) => setModel(event.target.value)}
            disabled={!usage || pending}
            className="mt-1 block h-10 w-full rounded-lg border border-zinc-300 bg-white px-3 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          >
            {(usage?.features.models.allowedModels ?? []).map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Prompt
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={4}
            maxLength={8_000}
            disabled={pending}
            className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white p-3 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
        </label>
        <button
          type="button"
          onClick={generate}
          disabled={pending || !model || !prompt.trim()}
          className="h-11 rounded-full bg-[#6E56CF] px-5 text-sm font-medium text-white hover:bg-[#5a45b3] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Checking entitlements…" : "Generate"}
        </button>
      </div>

      {output ? (
        <div className="mt-5 rounded-lg bg-zinc-50 p-4 text-sm text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
          {output}
        </div>
      ) : null}

      {usage ? (
        <div className="mt-7 grid gap-4">
          <Meter
            label="Input tokens today"
            used={usage.features.inputTokensDaily.used}
            limit={usage.features.inputTokensDaily.limit}
          />
          <Meter
            label="Output tokens today"
            used={usage.features.outputTokensDaily.used}
            limit={usage.features.outputTokensDaily.limit}
          />
          <Meter
            label="Credits this period"
            used={usage.features.creditsMonthly.used}
            limit={usage.features.creditsMonthly.limit}
          />
          <Meter
            label="Requests this minute"
            used={usage.features.apiRatePerMinute.used}
            limit={usage.features.apiRatePerMinute.limit}
          />
          <p className="text-xs text-zinc-500">
            SSO {usage.features.sso.enabled ? "enabled" : "not included"} · Max
            seats {formatLimit(usage.features.maxSeats.limit)}
          </p>
        </div>
      ) : null}
    </section>
  );
}
