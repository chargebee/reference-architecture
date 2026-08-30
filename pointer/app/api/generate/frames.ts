import type { UsageSnapshot } from "@/lib/entitlements/gate";

export const NDJSON_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";

export type UpgradeHint = {
  action: "upgrade" | "buy_credits";
  href: "/choose-plan";
};

export function upgradeHint(
  action: UpgradeHint["action"] = "upgrade",
): UpgradeHint {
  return { action, href: "/choose-plan" };
}

/**
 * What travels over a streamed 200. Denials raised before the body opens are
 * still plain JSON with a real status; anything that goes wrong after arrives
 * as an `error` frame.
 */
export type GenerateFrame =
  | { type: "delta"; text: string }
  | {
      type: "done";
      id: string;
      model: string;
      usage: {
        inputTokens: number;
        outputTokens: number;
        creditsConsumed: number;
        source: "plan_quota" | "credits";
      };
      limits: UsageSnapshot;
    }
  | {
      type: "error";
      error: string;
      message: string;
      featureId?: string;
      upgradeHint?: UpgradeHint;
      limits?: UsageSnapshot;
    };

/** NDJSON: one frame per line, so a reader can parse without buffering it all. */
export function encodeFrame(frame: GenerateFrame): string {
  return `${JSON.stringify(frame)}\n`;
}
