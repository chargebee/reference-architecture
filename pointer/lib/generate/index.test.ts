import { describe, expect, it, vi } from "vitest";

const { doStream } = vi.hoisted(() => ({ doStream: vi.fn() }));

vi.mock("./openrouter", async () => {
	const { MockLanguageModelV4 } = await import("ai/test");
	return { chatModel: () => new MockLanguageModelV4({ doStream }) };
});

import {
	GenerationError,
	estimateTokens,
	streamGeneration,
	validateGenerateInput,
} from "./index";

/** A `doStream` result; `undefined` totals mimic a provider that reports no usage. */
function reply(chunks: string[], inputTotal?: number, outputTotal?: number) {
	return {
		stream: new ReadableStream({
			start(controller) {
				controller.enqueue({ type: "stream-start", warnings: [] });
				controller.enqueue({ type: "text-start", id: "0" });
				for (const delta of chunks) {
					controller.enqueue({ type: "text-delta", id: "0", delta });
				}
				controller.enqueue({ type: "text-end", id: "0" });
				controller.enqueue({
					type: "finish",
					finishReason: "stop",
					usage: {
						inputTokens: {
							total: inputTotal,
							noCache: undefined,
							cacheRead: undefined,
							cacheWrite: undefined,
						},
						outputTokens: {
							total: outputTotal,
							text: undefined,
							reasoning: undefined,
						},
					},
				});
				controller.close();
			},
		}),
	};
}

const input = {
	prompt: "hello world",
	model: "openai/gpt-4o-mini",
	maxOutputTokens: 64,
};

async function collect(deltas: AsyncIterable<string>): Promise<string[]> {
	const seen: string[] = [];
	for await (const delta of deltas) {
		seen.push(delta);
	}
	return seen;
}

describe("openrouter streaming", () => {
	it("yields deltas and bills the counts the provider reported", async () => {
		doStream.mockResolvedValueOnce(reply(["hi ", "there"], 11, 7));

		const generation = streamGeneration(input, new AbortController().signal);

		await expect(collect(generation.deltas)).resolves.toEqual(["hi ", "there"]);
		await expect(generation.settle()).resolves.toEqual({
			output: "hi there",
			inputTokens: 11,
			outputTokens: 7,
		});
	});

	it("tracks a running estimate while the stream is open", async () => {
		doStream.mockResolvedValueOnce(reply(["12345678", "12345678"], 11, 7));

		const generation = streamGeneration(input, new AbortController().signal);
		const seen: number[] = [];
		for await (const delta of generation.deltas) {
			expect(delta).toHaveLength(8);
			seen.push(generation.streamedTokens());
		}

		// Four characters to the token, so two tokens per eight-character delta.
		expect(seen).toEqual([2, 4]);
	});

	it("falls back to estimates when the call was aborted", async () => {
		doStream.mockResolvedValueOnce(reply(["hi there"], 11, 7));

		const abort = new AbortController();
		const generation = streamGeneration(input, abort.signal);
		await collect(generation.deltas);
		abort.abort();

		await expect(generation.settle()).resolves.toEqual({
			output: "hi there",
			inputTokens: estimateTokens(input.prompt),
			outputTokens: estimateTokens("hi there"),
		});
	});

	it("raises an upstream failure once the reader drains", async () => {
		doStream.mockRejectedValueOnce(new Error("upstream exploded"));

		const generation = streamGeneration(input, new AbortController().signal);

		await expect(collect(generation.deltas)).rejects.toBeInstanceOf(
			GenerationError,
		);
	});

	it("rejects invalid request boundaries", () => {
		expect(() => validateGenerateInput({ prompt: "", model: "x" })).toThrow();
		expect(() =>
			validateGenerateInput({
				prompt: "ok",
				model: "x",
				maxOutputTokens: 4_097,
			}),
		).toThrow();
		expect(
			validateGenerateInput({
				prompt: "ok",
				model: "x",
				maxOutputTokens: 4_096,
			}),
		).toMatchObject({ maxOutputTokens: 4_096 });
	});
});
