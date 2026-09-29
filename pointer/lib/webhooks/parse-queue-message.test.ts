import { describe, expect, it } from "vitest";

import { PoisonWebhookError } from "./webhook-errors";
import {
	type ParsedQueueMessage,
	parseQueueMessage,
} from "./parse-queue-message";

function expectPoison(parsed: ParsedQueueMessage): PoisonWebhookError {
	if (parsed.kind !== "poison") {
		throw new Error(`expected poison message, received ${parsed.kind}`);
	}

	expect(parsed.error).toBeInstanceOf(PoisonWebhookError);
	return parsed.error;
}

describe("parseQueueMessage", () => {
	it("parses Chargebee events", () => {
		const event = {
			id: "event-1",
			event_type: "subscription_changed",
			content: {},
		};

		expect(parseQueueMessage(JSON.stringify(event))).toEqual({
			kind: "chargebee_event",
			event,
		});
	});

	it("parses entitlement sync jobs", () => {
		const job = {
			job: "entitlements.sync",
			id: "job-1",
			requestedAt: "2026-09-29T00:00:00.000Z",
			reason: "manual",
			chargebeeSubscriptionId: "subscription-1",
		};

		expect(parseQueueMessage(JSON.stringify(job))).toEqual({
			kind: "entitlement_sync",
			job,
		});
	});

	it("classifies malformed JSON as poison", () => {
		const error = expectPoison(parseQueueMessage("{invalid"));

		expect(error.message).toContain("unparseable webhook body");
	});

	it("classifies events without an id as poison", () => {
		const error = expectPoison(
			parseQueueMessage(JSON.stringify({ event_type: "customer_changed" })),
		);

		expect(error.message).toBe("webhook body is missing an event id");
	});
});
