import { RetryableWebhookError } from "@/lib/webhooks/webhook-errors";

/** Convert unknown failures into the error type that triggers SQS redelivery. */
export function toRetryableError(err: unknown): RetryableWebhookError {
	if (err instanceof RetryableWebhookError) {
		return err;
	}

	const message = err instanceof Error ? err.message : String(err);
	return new RetryableWebhookError(message, { cause: err });
}
