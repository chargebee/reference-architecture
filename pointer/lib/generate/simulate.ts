import { v7 as uuidv7 } from "uuid";

export type GenerateInput = {
  prompt: string;
  model: string;
  maxOutputTokens?: number;
};

export function validateGenerateInput(input: unknown): GenerateInput {
  if (!input || typeof input !== "object") {
    throw new Error("Request body must be an object");
  }
  const value = input as Record<string, unknown>;
  if (
    typeof value.prompt !== "string" ||
    value.prompt.trim().length < 1 ||
    value.prompt.length > 8_000
  ) {
    throw new Error("prompt must contain 1 to 8,000 characters");
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
      Number(value.maxOutputTokens) > 4_096)
  ) {
    throw new Error("maxOutputTokens must be an integer from 1 to 4,096");
  }
  return {
    prompt: value.prompt,
    model: value.model,
    ...(value.maxOutputTokens !== undefined
      ? { maxOutputTokens: Number(value.maxOutputTokens) }
      : {}),
  };
}

export function simulateGeneration(input: GenerateInput) {
  const inputTokens = Math.max(1, Math.ceil(input.prompt.length / 4));
  const outputTokens = Math.min(
    input.maxOutputTokens ?? 256,
    32 + (input.prompt.length % 225),
  );
  const excerpt =
    input.prompt.length > 180
      ? `${input.prompt.slice(0, 180)}…`
      : input.prompt;
  return {
    id: uuidv7(),
    model: input.model,
    output: `[simulated ${input.model}] ${excerpt}`,
    inputTokens,
    outputTokens,
  };
}
