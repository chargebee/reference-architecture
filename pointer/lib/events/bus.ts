import type { AppEvent, StreamedEvent } from "./types";

export interface SubscribeOptions {
  // Stream id to resume from. Defaults to "$" (live only). Pass "0-0" to
  // replay from the beginning.
  fromId?: string;
  signal: AbortSignal;
}

export interface EventBus {
  publish<T extends Record<string, unknown>>(
    event: AppEvent<T>,
  ): Promise<string>;
  subscribe(
    opts: SubscribeOptions,
    onEvent: (event: StreamedEvent) => void | Promise<void>,
  ): Promise<void>;
  recent(count: number): Promise<StreamedEvent[]>;
}
