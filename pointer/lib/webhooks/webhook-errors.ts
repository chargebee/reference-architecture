/**
 * Typed errors that drive the worker's SQS retry / dead-letter behaviour.
 *
 * The `@chargebee/better-auth` processor swallows its own hook errors, so the
 * worker classifies failures itself and throws one of these to decide the fate
 * of an SQS message.
 */

/**
 * Transient failure: dependency-not-ready (out-of-order delivery), a temporary
 * DB/network blip, or a silent-failure detected by verify-after-process.
 *
 * The worker rethrows this so sqs-consumer does NOT delete the message. SQS
 * makes it visible again after a backoff and, once `maxReceiveCount` is
 * exceeded, auto-routes it to the DLQ.
 */
export class RetryableWebhookError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "RetryableWebhookError";
	}
}

/**
 * Permanent failure: a malformed / un-processable payload. Retrying will never
 * help, so the worker routes it straight to the DLQ and acks the main-queue
 * message instead of burning the retry budget.
 */
export class PoisonWebhookError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "PoisonWebhookError";
	}
}
