import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isModelAllowed, loadModelTiers, modelsForTier } from "./models";

describe("model entitlement mapping", () => {
  it("loads every documented model tier", async () => {
    const tiers = await loadModelTiers();
    expect(tiers.basic).toContain("openai/gpt-4o-mini");
    expect(tiers.advanced).toContain("openai/gpt-4o");
    expect(tiers.premium).toContain("openai/gpt-5");
    expect(tiers.enterprise).toContain("*");
  });

  it("enforces lower tiers and enterprise wildcards", async () => {
    await expect(isModelAllowed("basic", "openai/gpt-5")).resolves.toBe(false);
    await expect(isModelAllowed("premium", "openai/gpt-5")).resolves.toBe(true);
    await expect(isModelAllowed("enterprise", "private-model")).resolves.toBe(
      true,
    );
    await expect(modelsForTier("enterprise")).resolves.not.toContain("*");
  });
});
