// Maps app event types to the React Flow edges that should pulse when the
// event arrives. A single event can light up multiple edges (e.g. the
// chargebee customer-create call also fans out into Chargebee's internal
// webhook delivery).

export type EdgeId =
  | "e_user_app"
  | "e_app_cbapi"
  | "e_cbapi_cbwebhook"
  | "e_cbwebhook_app"
  | "e_app_db";

export type NodeId =
  | "n_user"
  | "n_app"
  | "n_cbapi"
  | "n_cbwebhook"
  | "n_db";

export function edgesForEvent(eventType: string): EdgeId[] {
  switch (eventType) {
    case "app.user_created":
      return ["e_user_app", "e_app_db"];
    case "chargebee.customer_created":
      return ["e_app_cbapi", "e_cbapi_cbwebhook"];
    case "chargebee.webhook_received":
      return ["e_cbwebhook_app"];
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
    default:
      return null;
  }
}

// Short, human-friendly tag rendered on the active edge while it pulses.
// For Chargebee webhooks the interesting bit is the webhook subtype.
export function tagForEvent(
  eventType: string,
  data: Record<string, unknown>,
): string {
  if (eventType === "chargebee.webhook_received") {
    const sub = data["webhook_event_type"];
    if (typeof sub === "string") return sub;
  }
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
    default:
      return { shape: "diamond", color: "#a855f7" }; // violet-500
  }
}
