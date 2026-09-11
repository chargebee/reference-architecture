import { headers } from "next/headers";
import type { NextRequest } from "next/server";

import { auth } from "@/lib/auth";
import { getEventBus } from "@/lib/events/redis-stream-bus";

const DEFAULT_COUNT = 50;
const MAX_COUNT = 500;

export async function GET(request: NextRequest): Promise<Response> {
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session) {
		return new Response("Unauthorized", { status: 401 });
	}

	const raw = request.nextUrl.searchParams.get("count");
	const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_COUNT;
	const count = Math.min(
		Math.max(Number.isFinite(parsed) ? parsed : DEFAULT_COUNT, 1),
		MAX_COUNT,
	);

	try {
		const events = await getEventBus().recent(count);
		return Response.json({ events });
	} catch (err) {
		console.error("[events/recent] failed", err);
		return new Response("event bus unavailable", { status: 503 });
	}
}
