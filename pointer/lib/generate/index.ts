import { streamText } from "ai";

import { chatModel } from "./openrouter";

const MAX_PROMPT_CHARS = 8_000;
const MAX_OUTPUT_TOKENS = 4_096;
const CHARS_PER_TOKEN = 4;
const GENERATION_TIMEOUT_MS = 60_000;

export const DEFAULT_OUTPUT_TOKENS = 256;

const SYSTEM_PROMPT =
	"You are Pointer, a concise assistant. Answer directly, without preamble.";

export type GenerateInput = {
	prompt: string;
	model: string;
	maxOutputTokens?: number;
};

export type Generation = {
	output: string;
	inputTokens: number;
	outputTokens: number;
};

export type GenerationStream = {
	/** Text as the model produces it. */
	deltas: AsyncIterable<string>;
	/**
	 * Output tokens produced so far, estimated. Providers report real counts
	 * only once the stream ends, which is too late to police a budget against.
	 */
	streamedTokens: () => number;
	/** Settled counts, once `deltas` is exhausted or the call is aborted. */
	settle: () => Promise<Generation>;
};

/** The upstream provider failed. Distinct from an entitlement denial. */
export class GenerationError extends Error {
	constructor(message: string, options?: { cause: unknown }) {
		super(message, options);
	}
}

export function validateGenerateInput(input: unknown): GenerateInput {
	if (!input || typeof input !== "object") {
		throw new Error("Request body must be an object");
	}
	const value = input as Record<string, unknown>;
	if (
		typeof value.prompt !== "string" ||
		value.prompt.trim().length < 1 ||
		value.prompt.length > MAX_PROMPT_CHARS
	) {
		throw new Error(`prompt must contain 1 to ${MAX_PROMPT_CHARS} characters`);
	}
	if (
		typeof value.model !== "string" ||
		value.model.length < 1 ||
		value.model.length > 100
	) {
		throw new Error("model is required");
	}
	if (
		value.maxOutputTokens !== undefined &&
		(!Number.isInteger(value.maxOutputTokens) ||
			Number(value.maxOutputTokens) < 1 ||
			Number(value.maxOutputTokens) > MAX_OUTPUT_TOKENS)
	) {
		throw new Error(
			`maxOutputTokens must be an integer from 1 to ${MAX_OUTPUT_TOKENS}`,
		);
	}
	return {
		prompt: value.prompt,
		model: value.model,
		...(value.maxOutputTokens !== undefined
			? { maxOutputTokens: Number(value.maxOutputTokens) }
			: {}),
	};
}

/**
 * Cheap stand-in for a real tokenizer, at roughly four characters per token.
 * Used to report a request before it runs, and to bill a provider that
 * returned no usage of its own.
 */
export function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/**
 * Aborting `signal` stops the upstream call mid-answer, which is how the
 * caller enforces a token budget it can only estimate while text is arriving.
 */
export function streamGeneration(
	input: GenerateInput,
	signal: AbortSignal,
): GenerationStream {
	let failure: unknown;

	const result = streamText({
		model: chatModel(input.model),
		system: SYSTEM_PROMPT,
		prompt: input.prompt,
		maxOutputTokens: input.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS,
		timeout: GENERATION_TIMEOUT_MS,
		abortSignal: signal,
		// `textStream` drops error parts rather than throwing them, so a provider
		// fault is caught here and raised once the reader drains.
		onError: ({ error }) => {
			failure = error;
		},
	});

	let streamed = "";

	async function* read(): AsyncGenerator<string> {
		for await (const delta of result.textStream) {
			streamed += delta;
			yield delta;
		}
		if (failure) {
			throw new GenerationError(`${input.model} failed to generate`, {
				cause: failure,
			});
		}
	}

	return {
		deltas: read(),
		streamedTokens: () => estimateTokens(streamed),
		settle: async () => {
			// An aborted call never reports usage, so the estimate is what bills.
			const usage = signal.aborted
				? undefined
				: await Promise.resolve(result.usage).catch(() => undefined);

			return {
				output: streamed,
				inputTokens: usage?.inputTokens ?? estimateTokens(input.prompt),
				outputTokens: usage?.outputTokens ?? estimateTokens(streamed),
			};
		},
	};
}
