"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type KeyboardEvent } from "react";

import type { UsageSnapshot } from "@/lib/entitlements/gate";

type ApiError = {
  error: string;
  message: string;
  retryAfterSeconds?: number;
  upgradeHint?: { action: string; href: string };
};

const STATUS_POLL_MS = 2_000;
const STATUS_POLL_ATTEMPTS = 15;

const SUGGESTIONS = [
  "Explain runtime entitlements in one paragraph.",
  "How should I handle a failed Chargebee webhook?",
  "Draft a plan comparison for Starter vs Pro.",
];

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
      <div className="flex justify-between gap-3 text-[11px] text-zinc-500 dark:text-zinc-400">
        <span>{label}</span>
        <span className="tabular-nums">
          {used.toLocaleString()} / {formatLimit(limit)}
        </span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

export function AskPanel() {
  const router = useRouter();
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [output, setOutput] = useState("");
  const [asked, setAsked] = useState("");
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
    const question = prompt.trim();
    if (!question || !model || pending) return;
    setPending(true);
    setError(null);
    setOutput("");
    setAsked(question);
    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: question, model, maxOutputTokens: 256 }),
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

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void generate();
    }
  }

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 sm:text-4xl dark:text-zinc-50">
          What can Pointer help with?
        </h1>
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
          Ask anything — get pointed straight to the answer.
        </p>
      </div>

      {usage?.entitlementsPending ? (
        <div
          role="status"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        >
          Loading your plan entitlements from Chargebee. Free-tier limits apply
          until they arrive, then this page refreshes automatically.
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
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

      <div className="rounded-2xl border border-zinc-200 bg-white shadow-[0_20px_60px_-40px_rgba(110,86,207,0.5)] focus-within:border-[#6E56CF] dark:border-zinc-800 dark:bg-zinc-950">
        <label htmlFor="prompt" className="sr-only">
          Ask Pointer a question
        </label>
        <textarea
          id="prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={onComposerKeyDown}
          rows={3}
          maxLength={8_000}
          disabled={pending}
          placeholder="Ask anything…"
          className="block w-full resize-none bg-transparent p-4 text-zinc-900 outline-none placeholder:text-zinc-400 disabled:opacity-60 dark:text-zinc-100"
        />
        <div className="flex items-center justify-between gap-3 border-t border-zinc-100 px-3 py-2 dark:border-zinc-900">
          <label className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="sr-only sm:not-sr-only">Model</span>
            <select
              value={model}
              onChange={(event) => setModel(event.target.value)}
              disabled={!usage || pending}
              className="h-8 rounded-lg border border-zinc-200 bg-white px-2 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
            >
              {(usage?.features.models.allowedModels ?? []).map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={generate}
            disabled={pending || !model || !prompt.trim()}
            className="flex h-9 items-center gap-2 rounded-full bg-[#6E56CF] px-4 text-sm font-medium text-white transition-colors hover:bg-[#5a45b3] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? "Thinking…" : "Ask"}
            <span aria-hidden>↑</span>
          </button>
        </div>
      </div>

      {!output && !pending ? (
        <div className="flex flex-wrap justify-center gap-2">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => setPrompt(suggestion)}
              className="rounded-full border border-zinc-200 px-3 py-1.5 text-xs text-zinc-600 transition-colors hover:border-[#6E56CF] hover:text-zinc-900 dark:border-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}

      {output ? (
        <article className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
            You asked
          </p>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            {asked}
          </p>
          <p className="mt-4 text-xs font-medium uppercase tracking-wide text-[#6E56CF]">
            Pointer
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-zinc-800 dark:text-zinc-200">
            {output}
          </p>
        </article>
      ) : null}

      {usage ? (
        <div className="rounded-xl border border-zinc-200/70 px-4 py-3 dark:border-zinc-800/70">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
              Usage
            </span>
            <span className="rounded-full bg-violet-100 px-2.5 py-0.5 text-[11px] font-medium text-violet-800 dark:bg-violet-950 dark:text-violet-300">
              {usage.features.models.tier} models
            </span>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
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
          </div>
          <p className="mt-3 text-[11px] text-zinc-400">
            SSO {usage.features.sso.enabled ? "enabled" : "not included"} · Max
            seats {formatLimit(usage.features.maxSeats.limit)}
          </p>
        </div>
      ) : null}
    </section>
  );
}
