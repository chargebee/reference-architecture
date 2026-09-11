"use client";

import { useEffect, useReducer, useRef } from "react";

import type { StreamedEvent } from "@/lib/events/types";

import {
	edgesForEvent,
	type EdgeId,
	type PulseShape,
	shapeForEvent,
	tagForEvent,
} from "./mapping";

export const ANIMATION_MS = 2000;
const MAX_EVENTS = 200;

export interface EdgePulse {
	id: string;
	expiry: number;
	tag: string;
	shape: PulseShape;
	color: string;
}

interface State {
	events: StreamedEvent[];
	activeEdges: Partial<Record<EdgeId, EdgePulse[]>>;
	connected: boolean;
	lastError?: string;
}

type Action =
	| { type: "backfill"; events: StreamedEvent[] }
	| { type: "event"; event: StreamedEvent; now: number }
	| { type: "tick"; now: number }
	| { type: "connected"; ok: boolean; error?: string };

const initialState: State = {
	events: [],
	activeEdges: {},
	connected: false,
};

function reducer(state: State, action: Action): State {
	switch (action.type) {
		case "backfill": {
			const merged = dedupePrepend(state.events, action.events);
			return { ...state, events: merged };
		}
		case "event": {
			const events = dedupePrepend([action.event], state.events).slice(
				0,
				MAX_EVENTS,
			);
			const eventType = action.event.event.event_type;
			const tag = tagForEvent(eventType, action.event.event.data);
			const style = shapeForEvent(eventType);
			const expiry = action.now + ANIMATION_MS;
			const activeEdges = { ...state.activeEdges };
			for (const edgeId of edgesForEvent(eventType)) {
				const pulse: EdgePulse = {
					id: `${action.event.event.event_id}:${edgeId}`,
					expiry,
					tag,
					shape: style.shape,
					color: style.color,
				};
				activeEdges[edgeId] = [...(activeEdges[edgeId] ?? []), pulse];
			}
			return { ...state, events, activeEdges };
		}
		case "tick": {
			let changed = false;
			const next: Partial<Record<EdgeId, EdgePulse[]>> = {};
			for (const [edgeId, pulses] of Object.entries(state.activeEdges)) {
				if (!pulses) continue;
				const kept = pulses.filter((p) => p.expiry > action.now);
				if (kept.length !== pulses.length) changed = true;
				if (kept.length > 0) next[edgeId as EdgeId] = kept;
			}
			return changed ? { ...state, activeEdges: next } : state;
		}
		case "connected":
			return { ...state, connected: action.ok, lastError: action.error };
		default:
			return state;
	}
}

function dedupePrepend(
	next: StreamedEvent[],
	existing: StreamedEvent[],
): StreamedEvent[] {
	const seen = new Set<string>();
	const out: StreamedEvent[] = [];
	for (const e of [...next, ...existing]) {
		if (seen.has(e.stream_id)) continue;
		seen.add(e.stream_id);
		out.push(e);
	}
	return out;
}

export function useEventStream() {
	const [state, dispatch] = useReducer(reducer, initialState);
	const sinceRef = useRef<string>("$");

	useEffect(() => {
		let cancelled = false;
		let es: EventSource | null = null;

		async function bootstrap() {
			try {
				const res = await fetch("/api/events/recent", { cache: "no-store" });
				if (!res.ok) throw new Error(`recent ${res.status}`);
				const data = (await res.json()) as { events: StreamedEvent[] };
				if (cancelled) return;
				dispatch({ type: "backfill", events: data.events.reverse() });
				const newest = data.events[data.events.length - 1];
				if (newest) sinceRef.current = newest.stream_id;
			} catch (err) {
				if (!cancelled) {
					dispatch({
						type: "connected",
						ok: false,
						error: (err as Error).message,
					});
				}
			}

			if (cancelled) return;

			const url = `/api/events/stream?since=${encodeURIComponent(sinceRef.current)}`;
			es = new EventSource(url);

			es.onopen = () => {
				dispatch({ type: "connected", ok: true });
			};
			es.onerror = () => {
				// The browser auto-reconnects EventSource; surface the state in UI.
				dispatch({ type: "connected", ok: false, error: "stream interrupted" });
			};
			es.onmessage = (msg) => handleMessage(msg);
			// Named event listeners — SSE delivers each frame under its event_type
			// name, so subscribe to a wildcard via onmessage AND to the explicit
			// names we care about (browsers route only one of them).
			const namedTypes = [
				"app.user_created",
				"chargebee.customer_created",
				"chargebee.webhook_received",
				"chargebee.webhook_queued",
				"chargebee.webhook_processed",
			];
			for (const t of namedTypes) {
				es.addEventListener(t, handleMessage as EventListener);
			}
		}

		function handleMessage(msg: MessageEvent) {
			try {
				const parsed = JSON.parse(msg.data) as StreamedEvent;
				sinceRef.current = parsed.stream_id;
				dispatch({ type: "event", event: parsed, now: Date.now() });
			} catch (err) {
				console.error("[flow] bad SSE payload", err, msg.data);
			}
		}

		void bootstrap();

		const tick = setInterval(() => {
			dispatch({ type: "tick", now: Date.now() });
		}, 500);

		return () => {
			cancelled = true;
			clearInterval(tick);
			es?.close();
		};
	}, []);

	return state;
}
