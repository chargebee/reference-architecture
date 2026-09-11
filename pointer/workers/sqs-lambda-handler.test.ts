import type { Message } from "@aws-sdk/client-sqs";
import type { SQSEvent, SQSRecord } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";

import { createSqsBatchHandler } from "./sqs-lambda-handler";

function record(
	messageId: string,
	body: string,
	receiveCount = "1",
): SQSRecord {
	return {
		messageId,
		receiptHandle: `receipt-${messageId}`,
		body,
		attributes: {
			ApproximateReceiveCount: receiveCount,
			ApproximateFirstReceiveTimestamp: "1000",
			SenderId: "sender",
			SentTimestamp: "900",
		},
		messageAttributes: {},
		md5OfBody: "md5",
		eventSource: "aws:sqs",
		eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:pointer-queue",
		awsRegion: "us-east-1",
	};
}

describe("createSqsBatchHandler", () => {
	it("returns only failed records for partial retry", async () => {
		const processMessage = vi.fn(async (message: Message) => {
			if (message.MessageId === "retry") {
				throw new Error("transient");
			}
		});
		const handler = createSqsBatchHandler(async () => processMessage);
		const event: SQSEvent = {
			Records: [
				record("success", '{"id":"event-1"}'),
				record("retry", '{"id":"event-2"}', "4"),
			],
		};

		await expect(handler(event)).resolves.toEqual({
			batchItemFailures: [{ itemIdentifier: "retry" }],
		});
		expect(processMessage).toHaveBeenCalledTimes(2);
		expect(processMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				MessageId: "retry",
				ReceiptHandle: "receipt-retry",
				Attributes: expect.objectContaining({
					ApproximateReceiveCount: "4",
				}),
			}),
		);
	});

	it("fails the invocation when processor bootstrap fails", async () => {
		const handler = createSqsBatchHandler(async () => {
			throw new Error("secrets unavailable");
		});

		await expect(handler({ Records: [record("one", "{}")] })).rejects.toThrow(
			"secrets unavailable",
		);
	});
});
