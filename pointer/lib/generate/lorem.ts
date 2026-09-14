import type { GenerateInput, Generation, GenerationStream } from "./index";

// Must match the slug added to config/models.yaml.
export const LOREM_MODEL = "local/lorem-ipsum";

const LOREM_TEXT =
	"Lorem ipsum dolor sit amet, consectetur adipiscing elit. " +
	"Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. " +
	"Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris " +
	"nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in " +
	"reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla " +
	"pariatur. Excepteur sint occaecat cupidatat non proident, sunt in " +
	"culpa qui officia deserunt mollit anim id est laborum.";

// Simulates realistic streaming cadence without hitting the network.
const CHUNK_DELAY_MS = 40;

// Same ratio as estimateTokens() in index.ts — kept local to avoid a circular import.
const estimate = (text: string) => Math.max(1, Math.ceil(text.length / 4));

/**
 * Streams lorem ipsum word-by-word without calling any external API.
 * Drop-in replacement for streamGeneration() when model === LOREM_MODEL.
 */
export function streamLoremIpsum(
	input: GenerateInput,
	signal: AbortSignal,
): GenerationStream {
	const words = LOREM_TEXT.split(" ");
	let streamed = "";

	async function* read(): AsyncGenerator<string> {
		for (const word of words) {
			if (signal.aborted) { break; }
			const chunk = streamed.length === 0 ? word : ` ${word}`;
			streamed += chunk;
			yield chunk;
			await new Promise<void>((resolve) => setTimeout(resolve, CHUNK_DELAY_MS));
		}
	}

	return {
		deltas: read(),
		streamedTokens: () => estimate(streamed),
		settle: async (): Promise<Generation> => ({
			output: streamed,
			inputTokens: estimate(input.prompt),
			outputTokens: estimate(streamed),
		}),
	};
}
