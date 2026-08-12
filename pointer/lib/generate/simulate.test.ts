import { describe, expect, it } from "vitest";

import { simulateGeneration, validateGenerateInput } from "./simulate";

describe("simulated generation", () => {
  it("produces deterministic token counts", () => {
    const first = simulateGeneration({
      prompt: "hello world",
      model: "gpt-4o-mini",
      maxOutputTokens: 64,
    });
    const second = simulateGeneration({
      prompt: "hello world",
      model: "gpt-4o-mini",
      maxOutputTokens: 64,
    });

    expect(first.inputTokens).toBe(3);
    expect(first.outputTokens).toBe(43);
    expect(second).toMatchObject({
      model: first.model,
      output: first.output,
      inputTokens: first.inputTokens,
      outputTokens: first.outputTokens,
    });
    expect(second.id).not.toBe(first.id);
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
