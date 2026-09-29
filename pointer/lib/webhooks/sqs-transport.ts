import {
	ChangeMessageVisibilityCommand,
	SendMessageCommand,
	type Message,
	type SQSClient,
} from "@aws-sdk/client-sqs";
import type { WebhookEvent } from "chargebee";

import { emit } from "@/lib/events/emit";

const INITIAL_BACKOFF_SECONDS = 30;
const MAX_BACKOFF_SECONDS = 15 * 60;

export function backoffSeconds(receiveCount: number): number {
	const exponent = Math.max(0, receiveCount - 1);
	return Math.min(INITIAL_BACKOFF_SECONDS * 2 ** exponent, MAX_BACKOFF_SECONDS);
}

export interface SqsWebhookTransport {
	applyBackoff(message: Message, receiveCount: number): Promise<void>;
	routePoison(
		message: Message,
		event: WebhookEvent | undefined,
		err: unknown,
	): Promise<void>;
}

export interface SqsWebhookTransportOptions {
	queueUrl: string;
	dlqUrl: string;
	sqs: SQSClient;
}

export function createSqsWebhookTransport({
	queueUrl,
	dlqUrl,
	sqs,
}: SqsWebhookTransportOptions): SqsWebhookTransport {
	async function applyBackoff(
		message: Message,
		receiveCount: number,
	): Promise<void> {
		if (!message.ReceiptHandle) {
			return;
		}

		try {
			await sqs.send(
				new ChangeMessageVisibilityCommand({
					QueueUrl: queueUrl,
					ReceiptHandle: message.ReceiptHandle,
					VisibilityTimeout: backoffSeconds(receiveCount),
				}),
			);
		} catch (err) {
			// The queue's default visibility timeout remains the fallback.
			console.error("[chargebee-worker] failed to extend visibility", err);
		}
	}

	async function routePoison(
		message: Message,
		event: WebhookEvent | undefined,
		err: unknown,
	): Promise<void> {
		const reason = err instanceof Error ? err.message : String(err);

		console.error("[chargebee-worker] poison message -> DLQ", {
			messageId: message.MessageId,
			eventId: event?.id,
			reason,
		});

		await emit(
			"chargebee.webhook_dead_lettered",
			{
				webhook_event_type: event?.event_type,
				webhook_event_id: event?.id,
				sqs_message_id: message.MessageId,
				reason,
			},
			{ source: "worker", trace_id: event?.id },
		);

		await sqs.send(
			new SendMessageCommand({
				QueueUrl: dlqUrl,
				MessageBody: message.Body ?? "{}",
			}),
		);
	}

	return { applyBackoff, routePoison };
}
