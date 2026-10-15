import {
	createChargebeeWebhookProcessor,
	type ChargebeeWebhookProcessorSource,
} from "@chargebee/better-auth";
import type { WebhookEvent } from "chargebee";

import { auth, type Session } from "@/lib/auth";
import { resolveBillingSubject } from "@/lib/entitlements/subject";
import { syncSubscriptionEntitlements } from "@/lib/entitlements/sync";
import {
	findLiveSubscription,
	type LiveSubscription,
} from "@/lib/free-subscription";
import {
	chargebeeClient,
	chargebeePluginOptions,
} from "@/plugins/chargebee-plugin";

/**
 * A list entry carries the same `subscription` + `customer` content as the
 * `subscription_created` webhook, so the plugin's own hook writes the mirror
 * rows. The real webhook later finds them and skips.
 */
async function mirrorSubscription(live: LiveSubscription): Promise<void> {
	const processor = createChargebeeWebhookProcessor(chargebeePluginOptions, {
		auth,
	} as unknown as ChargebeeWebhookProcessorSource);
	await processor.process({
		id: `signup-${live.subscription.id}`,
		event_type: "subscription_created",
		content: live,
	} as unknown as WebhookEvent);
}

/**
 * Read-your-writes for sign-up. The free subscription was created through the
 * API moments ago, so its webhook is still in flight. Pull the subscription
 * and its entitlements from Chargebee instead of waiting for it.
 *
 *   sign-up ──► Chargebee: create subscription
 *   home    ──► Chargebee: list subscription  ──► mirror rows
 *           ──► Chargebee: fetch entitlements ──► snapshot
 *   webhook ──► rows exist, skipped
 */
export async function syncSignupBilling(session: Session): Promise<void> {
	try {
		const subject = await resolveBillingSubject(session, {
			customerType: "user",
		});
		if (!subject.chargebeeCustomerId) {
			return;
		}

		const live = await findLiveSubscription(
			chargebeeClient,
			subject.chargebeeCustomerId,
		);
		if (!live) {
			return;
		}

		await mirrorSubscription(live);
		await syncSubscriptionEntitlements(live.subscription.id, {
			trigger: "signup",
		});
	} catch (error) {
		// The webhook remains the correctness path; the provisioning page polls.
		console.error("[signup] direct billing sync failed", error);
	}
}
