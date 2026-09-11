/**
 * Thin wrapper around the Chargebee alert and alert_status APIs.
 *
 * Alert types:
 *   usage_exceeded        — monitors a metered feature; percentage or absolute
 *   spend_exceeded        — monitors overage spend in a currency; absolute only
 *   credit_balance_dropped — monitors a credit unit balance; absolute only
 *
 * Scope:
 *   global (subscription_id omitted) — applies to all subscriptions, optionally
 *     filtered by plan_price_id via filter_conditions
 *   subscription-scoped  — applies to one subscription only
 */

import type { Alert, AlertStatus } from "chargebee";

import { getRedis } from "@/lib/redis";
import { chargebeeClient } from "@/plugins/chargebee-plugin";

// ---------------------------------------------------------------------------
// Local alarm state — Redis cache keyed by subscription_id.
// Written by the worker when it processes alert_status_changed webhooks so the
// usage page shows alarm banners even before Chargebee's evaluation engine
// has propagated the status to the alertStatus API.
// ---------------------------------------------------------------------------

const ALARM_KEY_PREFIX = "pointer:alarm:";
/** TTL = 25 hours, covering the 24-hour billing evaluation window + margin. */
const ALARM_TTL_SECONDS = 25 * 60 * 60;

export type LocalAlarmEntry = {
	alert_id: string;
	subscription_id: string;
	alarm_status: "in_alarm" | "ok";
	alarm_triggered_at?: number;
	alert_name?: string;
	alert_type?: string;
	metered_feature_id?: string;
};

export async function setLocalAlarm(entry: LocalAlarmEntry): Promise<void> {
	const redis = getRedis();
	const key = `${ALARM_KEY_PREFIX}${entry.subscription_id}:${entry.alert_id}`;
	if (entry.alarm_status === "ok") {
		await redis.del(key);
	} else {
		await redis.set(key, JSON.stringify(entry), "EX", ALARM_TTL_SECONDS);
	}
}

export async function getLocalAlarms(
	subscriptionId: string,
): Promise<LocalAlarmEntry[]> {
	const redis = getRedis();
	const pattern = `${ALARM_KEY_PREFIX}${subscriptionId}:*`;
	const keys = await redis.keys(pattern);
	if (!keys.length) return [];
	const values = await redis.mget(...keys);
	return values
		.filter(Boolean)
		.map((v) => JSON.parse(v!) as LocalAlarmEntry)
		.filter((e) => e.alarm_status === "in_alarm");
}

export type { Alert, AlertStatus };

export async function listAlerts(): Promise<Alert[]> {
	const result = await chargebeeClient.alert.list({ limit: 100 });
	return result.list.map((entry) => entry.alert);
}

export async function listApplicableAlertsForSubscription(
	subscriptionId: string,
): Promise<Alert[]> {
	const result = await (
		chargebeeClient.alert as unknown as {
			application_alertsForSubscription: (
				id: string,
			) => Promise<{ list: { alert: Alert }[] }>;
		}
	).application_alertsForSubscription(subscriptionId);
	return result.list.map((entry) => entry.alert);
}

// alertStatus property exists at runtime but the SDK type file has a typo,
// and the method name uses snake_case with the SDK convention.
const alertStatusResource = (
	chargebeeClient as unknown as {
		alertStatus: {
			alert_statusesForSubscription: (
				subscriptionId: string,
				params?: { limit?: number; alarm_status?: { is?: string } },
			) => Promise<{ list: { alert_status: AlertStatus }[] }>;
		};
	}
).alertStatus;

export async function listAlertStatusesForSubscription(
	subscriptionId: string,
): Promise<AlertStatus[]> {
	const result = await alertStatusResource.alert_statusesForSubscription(
		subscriptionId,
		{ limit: 100 },
	);
	return result.list.map((entry) => entry.alert_status);
}

export async function listActiveAlarmsForSubscription(
	subscriptionId: string,
): Promise<AlertStatus[]> {
	// Fetch ALL statuses from Chargebee (not just in_alarm) so we can detect
	// when Chargebee has resolved an alarm that's still cached in Redis.
	const [cbResult, localAlarms] = await Promise.all([
		alertStatusResource
			.alert_statusesForSubscription(subscriptionId, { limit: 100 })
			.catch(() => ({ list: [] as { alert_status: AlertStatus }[] })),
		getLocalAlarms(subscriptionId),
	]);

	const allCbStatuses = cbResult.list.map((entry) => entry.alert_status);
	const cbAlarms = allCbStatuses.filter((s) => s.alarm_status === "in_alarm");

	// Build a set of alert_ids Chargebee explicitly marks as "ok".
	// These override any stale Redis entry — evict them from Redis asynchronously.
	const cbOkAlertIds = new Set(
		allCbStatuses.filter((s) => s.alarm_status === "ok").map((s) => s.alert_id),
	);
	for (const la of localAlarms) {
		if (cbOkAlertIds.has(la.alert_id)) {
			// Chargebee says resolved — clear the stale Redis key (fire-and-forget).
			setLocalAlarm({ ...la, alarm_status: "ok" }).catch(() => undefined);
		}
	}

	// Redis fills the gap only for alarms Chargebee hasn't propagated yet
	// (not in the Chargebee response at all — neither in_alarm nor ok).
	const cbKnownAlertIds = new Set(allCbStatuses.map((s) => s.alert_id));
	const localOnly = localAlarms
		.filter((la) => !cbKnownAlertIds.has(la.alert_id))
		.map(
			(la) =>
				({
					alert_id: la.alert_id,
					subscription_id: la.subscription_id,
					alarm_status: la.alarm_status,
					alarm_triggered_at: la.alarm_triggered_at,
					object: "alert_status",
				}) as AlertStatus,
		);

	return [...cbAlarms, ...localOnly];
}
