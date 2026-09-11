import { headers } from "next/headers";
import type { NextRequest } from "next/server";

import { auth } from "@/lib/auth";
import { getEventBus } from "@/lib/events/redis-stream-bus";

const HEARTBEAT_MS = 15_000;

function sseFrame(
	id: string,
	event: string,
	data: unknown,
	encoder: TextEncoder,
): Uint8Array {
	return encoder.encode(
		`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
	);
}

export async function GET(request: NextRequest): Promise<Response> {
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session) {
		return new Response("Unauthorized", { status: 401 });
	}

	const since = request.nextUrl.searchParams.get("since") ?? "$";
	const bus = getEventBus();
	const encoder = new TextEncoder();
	const ac = new AbortController();

	// Forward client disconnects to the bus subscription so the Redis socket
	// is torn down promptly (otherwise XREAD BLOCK can park it for BLOCK_MS).
	const onClientAbort = () => ac.abort();
	request.signal.addEventListener("abort", onClientAbort, { once: true });

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			const close = () => {
				if (closed) return;
				closed = true;
				clearInterval(heartbeat);
				try {
					controller.close();
				} catch {
					// ignored — controller may already be closed.
				}
			};

			controller.enqueue(encoder.encode(`: connected\n\n`));

			const heartbeat = setInterval(() => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`: hb ${Date.now()}\n\n`));
				} catch {
					close();
				}
			}, HEARTBEAT_MS);

			bus
				.subscribe({ fromId: since, signal: ac.signal }, (streamed) => {
					if (closed) return;
					try {
						controller.enqueue(
							sseFrame(
								streamed.stream_id,
								streamed.event.event_type,
								streamed,
								encoder,
							),
						);
					} catch {
						close();
						ac.abort();
					}
				})
				.catch((err) => {
					console.error("[sse] subscriber error", err);
				})
				.finally(() => {
					close();
				});
		},
		cancel() {
			ac.abort();
		},
	});

	return new Response(stream, {
		status: 200,
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}
