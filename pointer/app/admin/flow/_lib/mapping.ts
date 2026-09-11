// Maps app event types to the React Flow edges that should pulse when the
// event arrives. A single event can light up multiple edges (e.g. the
// chargebee customer-create call also fans out into Chargebee's internal
// webhook delivery).

export type EdgeId =
	| "e_user_app"
	| "e_app_cbapi"
	| "e_cbapi_cbwebhook"
	| "e_cbwebhook_app"
	| "e_app_queue"
	| "e_queue_worker"
	| "e_worker_db"
	| "e_app_db"
	| "e_app_redis"
	| "e_worker_redis";

export type NodeId =
	| "n_user"
	| "n_app"
	| "n_cbapi"
	| "n_cbwebhook"
	| "n_queue"
	| "n_worker"
	| "n_db"
	| "n_redis";

export function edgesForEvent(eventType: string): EdgeId[] {
	switch (eventType) {
		case "app.user_created":
			return ["e_user_app", "e_app_db"];
		case "chargebee.customer_created":
			return ["e_app_cbapi", "e_cbapi_cbwebhook"];
		case "chargebee.webhook_received":
			return ["e_cbwebhook_app"];
		case "chargebee.webhook_queued":
			return ["e_app_queue"];
		case "chargebee.webhook_processed":
			return ["e_queue_worker", "e_worker_db"];
		case "app.entitlements_sync_queued":
			return ["e_app_queue"];
		case "chargebee.entitlements_synced":
			return ["e_worker_db", "e_worker_redis"];
		// Entitlement checks and usage counters live in Redis, so every generate
		// request touches the cache before it touches anything else.
		case "app.generate_requested":
		case "app.generate_denied":
		case "app.generate_completed":
		case "app.usage_threshold":
			return ["e_user_app", "e_app_redis"];
		case "app.usage_ingested":
			return ["e_app_redis"];
		default:
			return [];
	}
}

export function nodeForEvent(eventType: string): NodeId | null {
	switch (eventType) {
		case "app.user_created":
			return "n_app";
		case "chargebee.customer_created":
			return "n_cbapi";
		case "chargebee.webhook_received":
			return "n_app";
		case "chargebee.webhook_queued":
			return "n_queue";
		case "chargebee.webhook_processed":
			return "n_worker";
		case "app.entitlements_sync_queued":
			return "n_queue";
		case "chargebee.entitlements_synced":
			return "n_worker";
		case "app.generate_requested":
		case "app.generate_denied":
		case "app.generate_completed":
		case "app.usage_threshold":
			return "n_app";
		case "app.usage_ingested":
			return "n_redis";
		default:
			return null;
	}
}

function webhookTag(data: Record<string, unknown>): string | null {
	const sub = data["webhook_event_type"];
	return typeof sub === "string" ? sub : null;
}

// Short, human-friendly tag rendered on the active edge while it pulses.
// For Chargebee webhooks the interesting bit is the webhook subtype.
export function tagForEvent(
	eventType: string,
	data: Record<string, unknown>,
): string {
	const webhook = webhookTag(data);
	if (webhook) return webhook;
	const feature = data["feature_id"];
	if (typeof feature === "string") return feature;
	const model = data["model"];
	if (typeof model === "string") return model;
	return eventType;
}

export type PulseShape = "circle" | "triangle" | "square" | "diamond";

export interface ShapeStyle {
	shape: PulseShape;
	color: string;
}

// Each event type gets a distinct shape + accent colour for the travelling
// particle so users can read the flow at a glance even when multiple events
// are in flight on the same edge.
export function shapeForEvent(eventType: string): ShapeStyle {
	switch (eventType) {
		case "app.user_created":
			return { shape: "circle", color: "#0ea5e9" }; // sky-500
		case "chargebee.customer_created":
			return { shape: "triangle", color: "#f59e0b" }; // amber-500
		case "chargebee.webhook_received":
			return { shape: "square", color: "#10b981" }; // emerald-500
		case "chargebee.webhook_queued":
			return { shape: "diamond", color: "#a855f7" }; // violet-500
		case "chargebee.webhook_processed":
			return { shape: "circle", color: "#6366f1" }; // indigo-500
		case "app.generate_denied":
			return { shape: "triangle", color: "#ef4444" }; // red-500
		case "app.usage_ingested":
			return { shape: "square", color: "#ef4444" }; // red-500
		case "app.generate_requested":
		case "app.generate_completed":
		case "app.usage_threshold":
			return { shape: "circle", color: "#6E56CF" };
		default:
			return { shape: "diamond", color: "#a855f7" }; // violet-500
	}
}
