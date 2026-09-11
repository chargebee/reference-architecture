import {
	createOpenRouter,
	type OpenRouterProvider,
} from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import process from "node:process";

const APP_NAME = "Pointer";
const DEFAULT_APP_URL = "http://localhost:3000";

let cachedProvider: OpenRouterProvider | undefined;

// Built on first use, not at import time: `next build` loads this module while
// collecting page data, long before an API key needs to exist.
function getProvider(): OpenRouterProvider {
	if (cachedProvider) return cachedProvider;

	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey) {
		throw new Error("OPENROUTER_API_KEY environment variable is required");
	}

	cachedProvider = createOpenRouter({
		apiKey,
		// `strict` sends the full OpenRouter request shape rather than the
		// lowest-common-denominator one kept for third-party gateways.
		compatibility: "strict",
		// Attributes spend to this app on the openrouter.ai dashboard.
		appName: APP_NAME,
		appUrl: process.env.BETTER_AUTH_URL ?? DEFAULT_APP_URL,
	});
	return cachedProvider;
}

/**
 * A chat model that reports what it actually cost. `usage.include` makes
 * OpenRouter return the upstream provider's token counts, which is what
 * entitlement metering bills against.
 */
export function chatModel(modelId: string): LanguageModel {
	return getProvider().chat(modelId, { usage: { include: true } });
}
