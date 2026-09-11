// Event envelope mirrors the contract in docs/01-architecture.md §5,
// trimmed for in-app fanout (no JWT-derived account/user partition keys yet).

export type EventSource = "app" | "chargebee" | "worker";

export type AppEventType =
	| "app.user_created"
	| "chargebee.customer_created"
	| "chargebee.webhook_received"
	| "chargebee.webhook_queued"
	| "chargebee.webhook_processed"
	| "chargebee.webhook_skipped_stale"
	| "chargebee.webhook_retry_scheduled"
	| "chargebee.webhook_dead_lettered"
	| "app.entitlements_sync_queued"
	| "chargebee.entitlements_synced"
	| "chargebee.entitlements_sync_failed"
	| "app.generate_requested"
	| "app.generate_denied"
	| "app.generate_completed"
	| "app.usage_threshold"
	| "app.usage_ingested"
	| "app.usage_ingest_failed"
	| "chargebee.alert_triggered"
	| "chargebee.alert_resolved";

export interface AppEvent<TData = Record<string, unknown>> {
	event_id: string;
	event_type: AppEventType | string;
	occurred_at: string;
	source: EventSource;
	trace_id?: string;
	data: TData;
}

export interface StreamedEvent<TData = Record<string, unknown>> {
	stream_id: string;
	event: AppEvent<TData>;
}
