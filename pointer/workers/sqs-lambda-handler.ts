import type { Message, MessageAttributeValue } from "@aws-sdk/client-sqs";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";

import type { ChargebeeWebhookMessageProcessor } from "./chargebee-webhook-processor";

function toSqsMessage(record: SQSRecord): Message {
	const messageAttributes: Record<string, MessageAttributeValue> = {};
	for (const [name, attribute] of Object.entries(record.messageAttributes)) {
		messageAttributes[name] = {
			DataType: attribute.dataType,
			StringValue: attribute.stringValue,
			BinaryValue: attribute.binaryValue
				? Buffer.from(attribute.binaryValue, "base64")
				: undefined,
			StringListValues: attribute.stringListValues,
			BinaryListValues: attribute.binaryListValues?.map((value) =>
				Buffer.from(value, "base64"),
			),
		};
	}

	return {
		MessageId: record.messageId,
		ReceiptHandle: record.receiptHandle,
		Body: record.body,
		Attributes: {
			ApproximateReceiveCount: record.attributes.ApproximateReceiveCount ?? "1",
			ApproximateFirstReceiveTimestamp:
				record.attributes.ApproximateFirstReceiveTimestamp,
			MessageDeduplicationId: record.attributes.MessageDeduplicationId,
			MessageGroupId: record.attributes.MessageGroupId,
			SenderId: record.attributes.SenderId,
			SentTimestamp: record.attributes.SentTimestamp,
			SequenceNumber: record.attributes.SequenceNumber,
			AWSTraceHeader: record.attributes.AWSTraceHeader,
			DeadLetterQueueSourceArn: record.attributes.DeadLetterQueueSourceArn,
		},
		MessageAttributes: messageAttributes,
		MD5OfBody: record.md5OfBody,
	};
}

/**
 * Create a Lambda SQS adapter without coupling the reusable batch semantics to
 * bootstrap or Secrets Manager. A bootstrap failure rejects the whole
 * invocation; individual message failures are returned for partial retry.
 */
export function createSqsBatchHandler(
	getProcessor: () => Promise<ChargebeeWebhookMessageProcessor>,
): (event: SQSEvent) => Promise<SQSBatchResponse> {
	return async (event) => {
		const processMessage = await getProcessor();
		const batchItemFailures: { itemIdentifier: string }[] = [];

		// Preserve the ECS consumer's per-process ordering and avoid multiplying
		// database work by the batch size inside each concurrent Lambda.
		for (const record of event.Records) {
			try {
				await processMessage(toSqsMessage(record));
			} catch (err) {
				console.error("[chargebee-worker] lambda record failed", {
					messageId: record.messageId,
					err,
				});
				batchItemFailures.push({ itemIdentifier: record.messageId });
			}
		}

		return { batchItemFailures };
	};
}
