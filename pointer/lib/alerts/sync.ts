/**
 * Processes Chargebee `alert_status_changed` webhooks.
 *
 * When Chargebee evaluates an alert and the status transitions (within_limit
 * → in_alarm or back), it fires this event. We emit a domain event so the
 * live /admin/flow view and any future notification consumers can react.
 */

import type { WebhookEvent } from "chargebee";

import { emit } from "@/lib/events/emit";
import { setLocalAlarm } from "@/lib/alerts/provider";

const ALERT_STATUS_CHANGED = "alert_status_changed";

/**
 * Returns true if the event was handled, false if it is not alert-related and
 * should continue through the normal webhook pipeline.
 */
export async function processAlertWebhook(
	event: WebhookEvent,
): Promise<boolean> {
	if (String(event.event_type) !== ALERT_STATUS_CHANGED) return false;

	const content = event.content as {
		alert?: {
			id?: string;
			name?: string;
			type?: string;
			metered_feature_id?: string;
			threshold?: { mode?: string; value?: number };
			subscription_id?: string | null;
		};
		alert_status?: {
			alert_id?: string;
			subscription_id?: string;
			alarm_status?: string;
			alarm_triggered_at?: number;
		};
	};

	const alert = content.alert;
	const status = content.alert_status;

	if (!(alert?.id && status?.subscription_id)) {
		console.log(
			"[alert] alert_status_changed received but missing alert.id or subscription_id — skipping",
			{
				eventId: event.id,
				alertId: alert?.id,
				subscriptionId: status?.subscription_id,
			},
		);
		return true;
	}

	const isAlarm = status.alarm_status === "in_alarm";

	console.log(`[alert] ${isAlarm ? "ALARM triggered" : "alarm resolved"}`, {
		eventId: event.id,
		alertId: alert.id,
		alertName: alert.name,
		meteredFeature: alert.metered_feature_id,
		subscriptionId: status.subscription_id,
		alarmStatus: status.alarm_status,
		thresholdMode: alert.threshold?.mode,
		thresholdValue: alert.threshold?.value,
	});

	await emit(
		isAlarm ? "chargebee.alert_triggered" : "chargebee.alert_resolved",
		{
			alert_id: alert.id,
			alert_name: alert.name,
			alert_type: alert.type,
			metered_feature_id: alert.metered_feature_id,
			threshold_mode: alert.threshold?.mode,
			threshold_value: alert.threshold?.value,
			subscription_id: status.subscription_id,
			alarm_status: status.alarm_status,
			alarm_triggered_at: status.alarm_triggered_at,
		},
		{ source: "worker", trace_id: event.id },
	);

	// Persist alarm state to Redis so the usage page shows banners immediately,
	// without waiting for Chargebee's evaluation engine to propagate the status.
	await setLocalAlarm({
		alert_id: alert.id,
		subscription_id: status.subscription_id,
		alarm_status: isAlarm ? "in_alarm" : "ok",
		alarm_triggered_at: status.alarm_triggered_at,
		alert_name: alert.name,
		alert_type: alert.type,
		metered_feature_id: alert.metered_feature_id,
	});

	console.log(
		`[alert] Redis alarm state updated — key pointer:alarm:${status.subscription_id}:${alert.id} → ${isAlarm ? "in_alarm" : "deleted"}`,
	);

	return true;
}
