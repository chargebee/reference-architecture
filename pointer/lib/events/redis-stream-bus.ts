import type { Redis } from "ioredis";

import { createRedisSubscriber, getRedis } from "@/lib/redis";

import type { EventBus, SubscribeOptions } from "./bus";
import type { AppEvent, StreamedEvent } from "./types";

export const STREAM_KEY = "pointer:events:chargebee-flow";
const STREAM_MAXLEN = 10_000;
const BLOCK_MS = 5_000;

function parseEntry(streamId: string, fields: string[]): StreamedEvent | null {
	// ioredis returns entries as [streamId, [field1, value1, field2, value2, ...]].
	// We always store a single field named "event".
	for (let i = 0; i < fields.length; i += 2) {
		if (fields[i] === "event") {
			try {
				const event = JSON.parse(fields[i + 1] ?? "{}") as AppEvent;
				return { stream_id: streamId, event };
			} catch (err) {
				console.error("[event-bus] failed to parse event", streamId, err);
				return null;
			}
		}
	}
	return null;
}

class RedisStreamBus implements EventBus {
	async publish<T extends Record<string, unknown>>(
		event: AppEvent<T>,
	): Promise<string> {
		const client = getRedis();
		const id = await client.xadd(
			STREAM_KEY,
			"MAXLEN",
			"~",
			String(STREAM_MAXLEN),
			"*",
			"event",
			JSON.stringify(event),
		);
		return id ?? "";
	}

	async recent(count: number): Promise<StreamedEvent[]> {
		const client = getRedis();
		// XREVRANGE returns newest first; reverse to chronological order.
		const entries = (await client.xrevrange(
			STREAM_KEY,
			"+",
			"-",
			"COUNT",
			String(count),
		)) as Array<[string, string[]]>;

		const events: StreamedEvent[] = [];
		for (const [streamId, fields] of entries) {
			const parsed = parseEntry(streamId, fields);
			if (parsed) events.push(parsed);
		}
		return events.reverse();
	}

	async subscribe(
		opts: SubscribeOptions,
		onEvent: (event: StreamedEvent) => void | Promise<void>,
	): Promise<void> {
		const client: Redis = createRedisSubscriber();
		let lastId = opts.fromId ?? "$";

		const cleanup = async () => {
			try {
				// disconnect() over quit() — quit() waits for a server reply that
				// never arrives while XREAD is blocking, leaving the connection
				// half-open until BLOCK_MS elapses.
				client.disconnect();
			} catch {
				// ignored
			}
		};

		if (opts.signal.aborted) {
			await cleanup();
			return;
		}
		const onAbort = () => {
			void cleanup();
		};
		opts.signal.addEventListener("abort", onAbort, { once: true });

		try {
			while (!opts.signal.aborted) {
				let result: Array<[string, Array<[string, string[]]>]> | null = null;
				try {
					result = (await client.xread(
						"BLOCK",
						BLOCK_MS,
						"STREAMS",
						STREAM_KEY,
						lastId,
					)) as Array<[string, Array<[string, string[]]>]> | null;
				} catch (err) {
					if (opts.signal.aborted) break;
					console.error("[event-bus] XREAD error", err);
					// Brief pause before retrying to avoid a tight error loop.
					await new Promise((r) => setTimeout(r, 500));
					continue;
				}

				if (!result) continue; // BLOCK timeout — loop and try again.

				for (const [, entries] of result) {
					for (const [streamId, fields] of entries) {
						lastId = streamId;
						const parsed = parseEntry(streamId, fields);
						if (parsed) {
							try {
								await onEvent(parsed);
							} catch (err) {
								console.error("[event-bus] subscriber threw", err);
							}
						}
					}
				}
			}
		} finally {
			opts.signal.removeEventListener("abort", onAbort);
			await cleanup();
		}
	}
}

let cached: EventBus | undefined;

export function getEventBus(): EventBus {
	if (!cached) cached = new RedisStreamBus();
	return cached;
}
