"use client";

import { useState } from "react";

import type { StreamedEvent } from "@/lib/events/types";

interface Props {
	events: StreamedEvent[];
}

export function EventLog({ events }: Props) {
	return (
		<aside className="flex h-[40vh] w-full flex-col rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950 lg:h-auto lg:w-[420px]">
			<header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
				<h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
					Live events
				</h2>
				<span className="text-xs text-zinc-500 dark:text-zinc-400">
					{events.length} recent
				</span>
			</header>
			<ol className="flex-1 divide-y divide-zinc-100 overflow-y-auto dark:divide-zinc-900">
				{events.length === 0 ? (
					<li className="px-4 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
						Waiting for the first event…
					</li>
				) : (
					events.map((entry) => <Row key={entry.stream_id} entry={entry} />)
				)}
			</ol>
		</aside>
	);
}

function Row({ entry }: { entry: StreamedEvent }) {
	const [expanded, setExpanded] = useState(false);
	const { event } = entry;
	const subtitle = subtitleFor(event.event_type, event.data);

	return (
		<li className="px-4 py-3 text-xs">
			<button
				type="button"
				onClick={() => setExpanded((v) => !v)}
				className="flex w-full items-start justify-between gap-3 text-left"
			>
				<div className="flex-1">
					<div className="flex items-center gap-2">
						<span className={badgeClass(event.source)}>{event.source}</span>
						<code className="font-mono text-[11px] text-zinc-900 dark:text-zinc-100">
							{event.event_type}
						</code>
					</div>
					{subtitle ? (
						<p className="mt-0.5 truncate text-[11px] text-zinc-500 dark:text-zinc-400">
							{subtitle}
						</p>
					) : null}
				</div>
				<time className="shrink-0 font-mono text-[10px] text-zinc-400">
					{new Date(event.occurred_at).toLocaleTimeString()}
				</time>
			</button>
			{expanded ? (
				<pre className="mt-2 max-h-64 overflow-auto rounded bg-zinc-50 p-2 font-mono text-[10px] leading-snug text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
					{JSON.stringify(event, null, 2)}
				</pre>
			) : null}
		</li>
	);
}

function badgeClass(source: string): string {
	const base =
		"inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide";
	if (source === "chargebee") {
		return `${base} bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200`;
	}
	if (source === "worker") {
		return `${base} bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200`;
	}
	return `${base} bg-indigo-100 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-200`;
}

function subtitleFor(
	type: string,
	data: Record<string, unknown>,
): string | null {
	if (
		type === "chargebee.webhook_received" ||
		type === "chargebee.webhook_queued" ||
		type === "chargebee.webhook_processed"
	) {
		const wt = data["webhook_event_type"];
		return typeof wt === "string" ? wt : null;
	}
	if (type.startsWith("app.generate") || type === "app.usage_threshold") {
		const model = data["model"];
		const feature = data["feature_id"];
		const error = data["error"];
		return [model, feature, error]
			.filter((value): value is string => typeof value === "string")
			.join(" · ");
	}
	if (type.includes(".entitlements_")) {
		return [
			data["subscription_id"] ?? data["chargebee_subscription_id"],
			data["trigger"],
			data["reason"],
		]
			.filter((value): value is string => typeof value === "string")
			.join(" · ");
	}
	const email = data["email"];
	const userId = data["userId"];
	if (typeof email === "string") return email;
	if (typeof userId === "string") return userId;
	return null;
}
