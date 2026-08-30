/**
 * Interval wrapper around `flushUsage`, run inside the existing webhook worker.
 *
 * No new service: `worker_min_count` is 1, so `pointer-worker` never scales to
 * zero, and the Redis consumer group fans entries across however many tasks
 * autoscaling creates. That is the same no-coordination property the SQS
 * consumer already relies on, so extra tasks need no leader election.
 *
 * Ticks never overlap. A pass that outruns the interval simply delays the next
 * one instead of stacking a second consumer on the same stream.
 */

import { hostname } from "node:os";

import { usageIngestEnabled } from "@/lib/usage/events";
import { flushUsage, type FlushResult } from "@/lib/usage/flush";

const DEFAULT_INTERVAL_MS = 60_000;
/** A backlog needs many passes; drain it promptly instead of one batch a minute. */
const BACKLOG_INTERVAL_MS = 1_000;

/**
 * A pass that settles nothing has not drained the backlog — Chargebee is
 * failing, or every entry is still held pending. Chasing depth alone would
 * retry a broken upstream every second, so the fast path needs both.
 */
export function nextDelay(result: FlushResult, idle: number): number {
  const settled = result.ingested + result.expired + result.exhausted;
  return result.depth > 0 && settled > 0 ? BACKLOG_INTERVAL_MS : idle;
}

function intervalMs(): number {
  const configured = Number(process.env.USAGE_FLUSH_INTERVAL_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_INTERVAL_MS;
}

export type UsageFlushLoop = { stop: () => Promise<void> };

export function startUsageFlushLoop(): UsageFlushLoop {
  // Identifies this task in the consumer group's pending list, so entries it
  // was holding when it died are attributable and reclaimable.
  const consumer = `${hostname()}-${process.pid}`;
  const tick = intervalMs();

  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;

  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(pass, delay);
  };

  const pass = () => {
    running = (async () => {
      try {
        const result = await flushUsage(consumer);
        if (result.ingested || result.expired || result.exhausted) {
          console.log("[usage-flush]", result);
        }
        schedule(nextDelay(result, tick));
      } catch (err) {
        console.error("[usage-flush] pass failed", err);
        schedule(tick);
      }
    })();
  };

  schedule(tick);
  console.log(`[usage-flush] every ${tick}ms as ${consumer}`);

  return {
    // Let the in-flight pass settle so its batch is acknowledged rather than
    // left pending for another worker to reclaim.
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}

/** No-op when usage tracking is unconfigured, so the worker boots unchanged. */
export function startUsageFlushIfEnabled(): UsageFlushLoop | null {
  if (!usageIngestEnabled()) {
    console.log("[usage-flush] disabled (CHARGEBEE_USAGE_INGEST_ENABLED)");
    return null;
  }
  return startUsageFlushLoop();
}
