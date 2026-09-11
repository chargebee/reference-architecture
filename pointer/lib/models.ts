import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import process from "node:process";

export type ModelTier = "basic" | "advanced" | "premium" | "enterprise";

const TIERS: ModelTier[] = ["basic", "advanced", "premium", "enterprise"];
const configPath = path.join(process.cwd(), "config", "models.yaml");

export async function loadModelTiers(): Promise<Record<ModelTier, string[]>> {
	const parsed = parse(await readFile(configPath, "utf8")) as unknown;
	if (!parsed || typeof parsed !== "object") {
		throw new Error("config/models.yaml must contain model tiers");
	}
	const object = parsed as Record<string, unknown>;
	return Object.fromEntries(
		TIERS.map((tier) => {
			const models = object[tier];
			if (
				!Array.isArray(models) ||
				models.some((model) => typeof model !== "string")
			) {
				throw new Error(
					`config/models.yaml tier ${tier} must be a string list`,
				);
			}
			return [tier, [...new Set(models)]];
		}),
	) as Record<ModelTier, string[]>;
}

export function isModelTier(value: string): value is ModelTier {
	return TIERS.includes(value as ModelTier);
}

export async function modelsForTier(tier: ModelTier): Promise<string[]> {
	const tiers = await loadModelTiers();
	if (!tiers[tier].includes("*")) return tiers[tier];
	return [
		...new Set(
			TIERS.flatMap((name) => tiers[name]).filter(
				(model) => model !== "*" && !model.endsWith(":*"),
			),
		),
	];
}

export async function isModelAllowed(
	tier: ModelTier,
	model: string,
): Promise<boolean> {
	const patterns = (await loadModelTiers())[tier];
	return patterns.some(
		(pattern) =>
			pattern === "*" ||
			pattern === model ||
			(pattern.endsWith(":*") && model.startsWith(pattern.slice(0, -1))),
	);
}
