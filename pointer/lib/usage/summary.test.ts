import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ retrieve: vi.fn() }));

vi.mock("@/plugins/chargebee-plugin", () => ({
  chargebeeClient: {
    usageSummary: { retrieveUsageSummaryForSubscription: mocks.retrieve },
  },
}));

import { fetchUsageSummary, isUsageWindow, snapToWindow } from "./summary";

/** Wednesday, 29 July 2026 at 14:20:33 UTC. */
const MIDWEEK = new Date("2026-07-29T14:20:33.000Z");

function page(
  values: number[],
  nextOffset?: string,
): { list: unknown[]; next_offset?: string } {
  return {
    list: values.map((value, index) => ({
      usage_summary: {
        subscription_id: "sub-1",
        feature_id: "Input-tokens",
        aggregated_value: String(value),
        aggregated_from: 1_760_000_000 + index * 3_600,
        aggregated_to: 1_760_000_000 + (index + 1) * 3_600,
      },
    })),
    ...(nextOffset ? { next_offset: nextOffset } : {}),
  };
}

beforeEach(() => {
  mocks.retrieve.mockReset();
});

describe("snapToWindow", () => {
  it("floors to the UTC hour", () => {
    expect(snapToWindow(MIDWEEK, "hour").toISOString()).toBe(
      "2026-07-29T14:00:00.000Z",
    );
  });

  it("floors to UTC midnight", () => {
    expect(snapToWindow(MIDWEEK, "day").toISOString()).toBe(
      "2026-07-29T00:00:00.000Z",
    );
  });

  it("floors to the ISO week's Monday", () => {
    expect(snapToWindow(MIDWEEK, "week").toISOString()).toBe(
      "2026-07-27T00:00:00.000Z",
    );
  });

  it("treats Sunday as the end of its week, not the start", () => {
    const sunday = new Date("2026-08-02T09:00:00.000Z");

    expect(snapToWindow(sunday, "week").toISOString()).toBe(
      "2026-07-27T00:00:00.000Z",
    );
  });

  it("floors to the first of the month", () => {
    expect(snapToWindow(MIDWEEK, "month").toISOString()).toBe(
      "2026-07-01T00:00:00.000Z",
    );
  });
});

describe("isUsageWindow", () => {
  it("rejects a window Chargebee would not accept from us", () => {
    expect(isUsageWindow("day")).toBe(true);
    expect(isUsageWindow("fortnight")).toBe(false);
  });
});

describe("fetchUsageSummary", () => {
  it("queries the metered feature id with a calendar-snapped start", async () => {
    mocks.retrieve.mockResolvedValue(page([1]));

    await fetchUsageSummary({
      subscriptionId: "sub-1",
      metric: "input_tokens",
      window: "day",
      from: MIDWEEK,
      to: new Date("2026-07-30T14:20:33.000Z"),
    });

    expect(mocks.retrieve).toHaveBeenCalledWith(
      "sub-1",
      expect.objectContaining({
        feature_id: "Input-tokens",
        window_size: "day",
        // 2026-07-29T00:00:00Z, not the 14:20 the caller passed.
        timeframe_start: Date.UTC(2026, 6, 29) / 1_000,
      }),
    );
  });

  it("coerces the string aggregate the SDK declares", async () => {
    mocks.retrieve.mockResolvedValue(page([42]));

    const series = await fetchUsageSummary({
      subscriptionId: "sub-1",
      metric: "output_tokens",
      window: "day",
      from: MIDWEEK,
      to: new Date("2026-07-30T00:00:00.000Z"),
    });

    expect(series.points[0]?.value).toBe(42);
    expect(series.unit).toBe("token");
  });

  it("follows next_offset until the last page", async () => {
    mocks.retrieve
      .mockResolvedValueOnce(page([1, 2], "cursor-2"))
      .mockResolvedValueOnce(page([3]));

    const series = await fetchUsageSummary({
      subscriptionId: "sub-1",
      metric: "generations",
      window: "hour",
      from: MIDWEEK,
      to: new Date("2026-07-30T00:00:00.000Z"),
    });

    expect(mocks.retrieve).toHaveBeenCalledTimes(2);
    expect(mocks.retrieve.mock.calls[1]?.[1]).toMatchObject({
      offset: "cursor-2",
    });
    expect(series.points.map((p) => p.value)).toEqual([1, 2, 3]);
    expect(series.truncated).toBe(false);
  });
});
