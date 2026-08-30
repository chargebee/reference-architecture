/**
 * Redis Streams driver for the usage-event buffer.
 *
 * Every Redis mechanic lives here: the consumer group, the reads, the
 * acknowledgements, the reclaim of entries a dead worker was holding. Callers
 * above this file work with `UsageStreamEntry` and never see a stream id
 * format, a PEL, or an ioredis argument list.
 *
 * # Why a stream and not the webhook queue
 *
 * Chargebee ingests up to 500 events per batch, and `XREADGROUP COUNT 500`
 * fills exactly one batch per round trip. SQS `ReceiveMessage` caps at 10, so
 * the same batch would cost 50 calls. The write side matters too: `XADD` on an
 * open connection is sub-millisecond, against 10-30ms for an HTTPS
 * `SendMessage` on the hot path of every generation.
 *
 * # Delivery guarantees
 *
 *   XADD ─▶ XREADGROUP '>' ─▶ (ingest) ─▶ XACK + XDEL
 *              │
 *              └─ crash ─▶ entry stays in the PEL ─▶ XCLAIM by the next worker
 *
 * At-least-once. A replayed batch is harmless because Chargebee deduplicates on
 * (deduplication_id, subscription_id, usage_timestamp).
 */

import type { Redis } from "ioredis";

import { getRedis } from "@/lib/redis";

import type { BufferedUsageEvent } from "./events";

export const USAGE_STREAM_KEY = "pointer:usage:events";
/** Terminal parking for events Chargebee will never accept. Drained by hand. */
export const USAGE_DEAD_STREAM_KEY = "pointer:usage:dead";
const CONSUMER_GROUP = "usage-flush";

/** Chargebee's per-request ceiling. One read fills one batch. */
export const MAX_BATCH_SIZE = 500;

/**
 * ~100k entries, roughly 30MB. At the 60s flush interval that absorbs a
 * sustained 1,600 generations/sec, far above anything this app will see.
 * Trimming is approximate (`~`) so Redis only drops whole macro-nodes.
 */
const STREAM_MAXLEN = 100_000;

const EVENT_FIELD = "event";

export type UsageStreamEntry = {
  id: string;
  event: BufferedUsageEvent;
  /** Delivery attempts so far, 1 on the first read. Drives dead-lettering. */
  deliveries: number;
};

/** ioredis returns entries as [id, [field, value, ...]]. */
type RawEntry = [string, string[]];
/** XPENDING extended form: [id, consumer, idleMs, deliveryCount]. */
type RawPending = [string, string, string | number, string | number];

function parseEntry(
  id: string,
  fields: string[],
  deliveries: number,
): UsageStreamEntry | null {
  for (let i = 0; i < fields.length; i += 2) {
    if (fields[i] !== EVENT_FIELD) continue;
    try {
      return {
        id,
        deliveries,
        event: JSON.parse(fields[i + 1] ?? "{}") as BufferedUsageEvent,
      };
    } catch (err) {
      console.error("[usage-stream] unparseable entry", id, err);
      return null;
    }
  }
  return null;
}

function parseEntries(
  raw: RawEntry[],
  deliveries: (id: string) => number,
): UsageStreamEntry[] {
  const entries: UsageStreamEntry[] = [];
  for (const [id, fields] of raw) {
    // A claimed entry that has since been XDEL'd comes back with null fields.
    if (!fields) continue;
    const parsed = parseEntry(id, fields, deliveries(id));
    if (parsed) entries.push(parsed);
  }
  return entries;
}

/** Appends to the buffer. Bounded so a stalled flusher cannot exhaust memory. */
export async function appendUsageEvent(
  event: BufferedUsageEvent,
): Promise<void> {
  await getRedis().xadd(
    USAGE_STREAM_KEY,
    "MAXLEN",
    "~",
    String(STREAM_MAXLEN),
    "*",
    EVENT_FIELD,
    JSON.stringify(event),
  );
}

/**
 * Creates the consumer group, starting at the oldest entry so nothing written
 * before the first worker booted is skipped. Safe to call on every tick.
 */
export async function ensureConsumerGroup(): Promise<void> {
  try {
    await getRedis().xgroup(
      "CREATE",
      USAGE_STREAM_KEY,
      CONSUMER_GROUP,
      "0",
      "MKSTREAM",
    );
  } catch (err) {
    // BUSYGROUP means another worker won the race. That is the success case.
    if (!(err instanceof Error) || !err.message.includes("BUSYGROUP")) throw err;
  }
}

/** Reads entries never delivered to any consumer. */
export async function readUsageBatch(
  consumer: string,
  count = MAX_BATCH_SIZE,
): Promise<UsageStreamEntry[]> {
  const result = (await getRedis().xreadgroup(
    "GROUP",
    CONSUMER_GROUP,
    consumer,
    "COUNT",
    count,
    "STREAMS",
    USAGE_STREAM_KEY,
    ">",
  )) as Array<[string, RawEntry[]]> | null;

  if (!result) return [];

  return result.flatMap(([, raw]) => parseEntries(raw, () => 1));
}

/**
 * Takes over entries whose owner stopped acknowledging — a task that was
 * scaled in, deployed over, or crashed. `XPENDING` is consulted first because
 * it is the only source of the delivery count that dead-lettering keys off.
 */
export async function reclaimStale(
  consumer: string,
  minIdleMs: number,
  count = MAX_BATCH_SIZE,
): Promise<UsageStreamEntry[]> {
  const redis: Redis = getRedis();
  const pending = (await redis.xpending(
    USAGE_STREAM_KEY,
    CONSUMER_GROUP,
    "IDLE",
    minIdleMs,
    "-",
    "+",
    count,
  )) as RawPending[] | null;

  if (!pending?.length) return [];

  const deliveries = new Map(
    pending.map(([id, , , count]) => [id, Number(count)]),
  );
  const claimed = (await redis.xclaim(
    USAGE_STREAM_KEY,
    CONSUMER_GROUP,
    consumer,
    minIdleMs,
    ...pending.map(([id]) => id),
  )) as RawEntry[];

  return parseEntries(claimed, (id) => deliveries.get(id) ?? 1);
}

/**
 * Settles entries. `XACK` clears the PEL; `XDEL` reclaims the memory rather
 * than waiting for MAXLEN trimming to reach them.
 */
export async function ackUsageEvents(ids: string[]): Promise<void> {
  if (!ids.length) return;

  await getRedis()
    .multi()
    .xack(USAGE_STREAM_KEY, CONSUMER_GROUP, ...ids)
    .xdel(USAGE_STREAM_KEY, ...ids)
    .exec();
}

/**
 * Parks entries that can never succeed — past Chargebee's 12-hour backdating
 * window, or rejected too many times — and settles them so the pump moves on.
 */
export async function deadLetterUsageEvents(
  entries: UsageStreamEntry[],
  reason: string,
): Promise<void> {
  if (!entries.length) return;

  const pipeline = getRedis().pipeline();
  for (const entry of entries) {
    pipeline.xadd(
      USAGE_DEAD_STREAM_KEY,
      "MAXLEN",
      "~",
      String(STREAM_MAXLEN),
      "*",
      EVENT_FIELD,
      JSON.stringify(entry.event),
      "reason",
      reason,
      "deliveries",
      String(entry.deliveries),
    );
  }
  await pipeline.exec();

  await ackUsageEvents(entries.map((entry) => entry.id));
}

/** Buffer depth, for the flush loop's log line and backlog alarms. */
export async function usageStreamDepth(): Promise<number> {
  return getRedis().xlen(USAGE_STREAM_KEY);
}
