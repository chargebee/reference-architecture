import { v7 as uuidv7 } from "uuid";

import type { AppEvent, EventSource } from "./types";

interface EmitOptions {
	source?: EventSource;
	trace_id?: string;
}

export async function emit<T extends Record<string, unknown>>(
	event_type: string,
	data: T,
	opts: EmitOptions = {},
): Promise<void> {
	const envelope: AppEvent<T> = {
		event_id: uuidv7(),
		event_type,
		occurred_at: new Date().toISOString(),
		source:
			opts.source ??
			(event_type.startsWith("chargebee.") ? "chargebee" : "app"),
		trace_id: opts.trace_id,
		data,
	};

	try {
		// Lazy-import so the Redis-backed bus (and ioredis) is only pulled in when
		// an event is actually published. This keeps `redis-stream-bus`/`ioredis`
		// out of the static import graph of anything that only imports `emit`
		// (e.g. `lib/auth.ts`), so tools that merely load the auth config — like
		// the Better Auth CLI's jiti loader — don't have to resolve Redis.
		const { getEventBus } = await import("./redis-stream-bus");
		await getEventBus().publish(envelope);
	} catch (err) {
		// The bus is a best-effort observation tap; never fail the caller.
		console.error(`[events] failed to publish ${event_type}`, err);
	}
}
