import { v7 as uuidv7 } from "uuid";

import { getEventBus } from "./redis-stream-bus";
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
    source: opts.source ?? (event_type.startsWith("chargebee.") ? "chargebee" : "app"),
    trace_id: opts.trace_id,
    data,
  };

  try {
    await getEventBus().publish(envelope);
  } catch (err) {
    // The bus is a best-effort observation tap; never fail the caller.
    console.error(`[events] failed to publish ${event_type}`, err);
  }
}
