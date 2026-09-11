/**
 * GET /api/alerts/status
 *
 * Returns the current alarm state for all alerts that apply to the current
 * user's active subscription. Includes the alert configuration so the client
 * has name/threshold context alongside the status.
 */

import { headers } from "next/headers";

import { auth } from "@/lib/auth";
import {
	listActiveAlarmsForSubscription,
	listAlerts,
	listApplicableAlertsForSubscription,
} from "@/lib/alerts/provider";
import { resolveEntitlementSubject } from "@/lib/entitlements/subject";

export async function GET(): Promise<Response> {
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session)
		return Response.json({ error: "unauthorized" }, { status: 401 });

	const subject = await resolveEntitlementSubject(session, {
		customerType: "user",
	});
	if (!subject) return Response.json({ alarms: [], alerts: [] });

	const [alarms, applicableAlerts, allAlerts] = await Promise.all([
		listActiveAlarmsForSubscription(subject.chargebeeSubscriptionId),
		listApplicableAlertsForSubscription(subject.chargebeeSubscriptionId),
		listAlerts(),
	]);

	// Merge applicable + all alerts for enrichment (applicable may be empty for
	// global alerts that haven't been linked to the subscription yet).
	const alertMap = new Map([
		...allAlerts.map((a) => [a.id, a] as [string, typeof a]),
		...applicableAlerts.map((a) => [a.id, a] as [string, typeof a]),
	]);

	// Enrich each alarm with the alert config for display.
	const enriched = alarms.map((alarm) => ({
		...alarm,
		alert: alertMap.get(alarm.alert_id) ?? null,
	}));

	return Response.json({ alarms: enriched, total: enriched.length });
}
