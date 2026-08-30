/**
 * The batch pump: drain the usage buffer into Chargebee.
 *
 *   reclaim stale ─▶ read new ─▶ drop expired ─▶ ingest ─▶ ack
 *                                     │            │
 *                                     └─ dead ◀────┘ (exhausted)
 *
 * Runtime-agnostic on purpose. The ECS worker calls `flushUsage` on an
 * interval; an EventBridge-scheduled Lambda could call the same function
 * without changing anything here.
 *
 * Each pass moves at most one Chargebee batch so a single tick has a bounded
 * cost. A deep backlog drains over successive ticks rather than in one long
 * call that could outlive the process.
 */

import { emit } from "@/lib/events/emit";

import {
  MAX_DELIVERIES,
  ingestBatch,
  splitExhausted,
  splitExpired,
} from "./ingest";
import {
  ackUsageEvents,
  deadLetterUsageEvents,
  ensureConsumerGroup,
  readUsageBatch,
  reclaimStale,
  usageStreamDepth,
  type UsageStreamEntry,
} from "./stream";

/**
 * How long an entry may sit unacknowledged before another worker takes it.
 * Comfortably longer than a flush pass, so a slow ingest is not stolen from
 * the worker that is still working on it.
 */
const RECLAIM_IDLE_MS = 5 * 60 * 1_000;

export type FlushResult = {
  ingested: number;
  retrying: number;
  expired: number;
  exhausted: number;
  /** Entries still buffered after this pass. Non-zero means drain continues. */
  depth: number;
};

const EMPTY: FlushResult = {
  ingested: 0,
  retrying: 0,
  expired: 0,
  exhausted: 0,
  depth: 0,
};

/**
 * Entries a previous worker claimed and never settled come first, so a crashed
 * task's work is finished before it ages out of the backdating window.
 */
async function collect(consumer: string): Promise<UsageStreamEntry[]> {
  const reclaimed = await reclaimStale(consumer, RECLAIM_IDLE_MS);
  if (reclaimed.length) return reclaimed;

  return readUsageBatch(consumer);
}

export async function flushUsage(consumer: string): Promise<FlushResult> {
  await ensureConsumerGroup();

  const collected = await collect(consumer);
  if (!collected.length) return EMPTY;

  // Chargebee will never accept these, and retrying only wastes attempts.
  const { fresh, expired } = splitExpired(collected);
  await deadLetterUsageEvents(expired, "backdating_window_exceeded");

  const { retryable, exhausted } = splitExhausted(fresh);
  await deadLetterUsageEvents(exhausted, `exceeded_${MAX_DELIVERIES}_attempts`);

  if (!retryable.length) {
    return {
      ...EMPTY,
      expired: expired.length,
      exhausted: exhausted.length,
      depth: await usageStreamDepth(),
    };
  }

  const result = await ingestBatch(retryable);

  // Only the accepted entries are settled. The rest stay in the pending list
  // and are picked up by the next reclaim, with their delivery count raised.
  await ackUsageEvents(result.ingested.map((entry) => entry.id));

  const depth = await usageStreamDepth();

  if (result.ingested.length) {
    await emit(
      "app.usage_ingested",
      {
        batch_id: result.batchId,
        event_count: result.ingested.length,
        buffered: depth,
      },
      { source: "worker" },
    );
  }

  if (result.failed.length) {
    await emit(
      "app.usage_ingest_failed",
      { batch_id: result.batchId, event_count: result.failed.length },
      { source: "worker" },
    );
  }

  return {
    ingested: result.ingested.length,
    retrying: result.failed.length,
    expired: expired.length,
    exhausted: exhausted.length,
    depth,
  };
}
