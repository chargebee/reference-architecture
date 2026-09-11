import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ readUsageSeries: vi.fn() }));

vi.mock("./store", () => ({ readUsageSeries: mocks.readUsageSeries }));

import { fetchUsageSummary, isUsageWindow, snapToWindow } from "./summary";

/** Wednesday, 29 July 2026 at 14:20:33 UTC. */
const MIDWEEK = new Date("2026-07-29T14:20:33.000Z");

function bucket(iso: string, value: number) {
	return { from: new Date(iso), value };
}

beforeEach(() => {
	mocks.readUsageSeries.mockReset();
	mocks.readUsageSeries.mockResolvedValue([]);
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
	it("rejects a window the aggregate has no bucket for", () => {
		expect(isUsageWindow("day")).toBe(true);
		expect(isUsageWindow("fortnight")).toBe(false);
	});
});

describe("fetchUsageSummary", () => {
	it("queries from a calendar-snapped start", async () => {
		await fetchUsageSummary({
			subscriptionId: "sub-1",
			metric: "input_tokens",
			window: "day",
			from: MIDWEEK,
			to: new Date("2026-07-30T14:20:33.000Z"),
		});

		expect(mocks.readUsageSeries).toHaveBeenCalledWith(
			expect.objectContaining({
				subscriptionId: "sub-1",
				metric: "input_tokens",
				window: "day",
				// 2026-07-29T00:00:00Z, not the 14:20 the caller passed.
				from: new Date("2026-07-29T00:00:00.000Z"),
			}),
		);
	});

	it("carries the metered feature's identity and unit", async () => {
		mocks.readUsageSeries.mockResolvedValue([
			bucket("2026-07-29T00:00:00.000Z", 42),
		]);

		const series = await fetchUsageSummary({
			subscriptionId: "sub-1",
			metric: "output_tokens",
			window: "day",
			from: MIDWEEK,
			to: new Date("2026-07-30T00:00:00.000Z"),
		});

		expect(series.points[0]?.value).toBe(42);
		expect(series.featureId).toBe("Output-tokens");
		expect(series.unit).toBe("token");
	});

	it("emits a zero bucket where nothing was recorded", async () => {
		mocks.readUsageSeries.mockResolvedValue([
			bucket("2026-07-29T00:00:00.000Z", 5),
			bucket("2026-07-31T00:00:00.000Z", 7),
		]);

		const series = await fetchUsageSummary({
			subscriptionId: "sub-1",
			metric: "generations",
			window: "day",
			from: MIDWEEK,
			to: new Date("2026-08-01T00:00:00.000Z"),
		});

		expect(series.points).toEqual([
			{
				from: "2026-07-29T00:00:00.000Z",
				to: "2026-07-30T00:00:00.000Z",
				value: 5,
			},
			{
				from: "2026-07-30T00:00:00.000Z",
				to: "2026-07-31T00:00:00.000Z",
				value: 0,
			},
			{
				from: "2026-07-31T00:00:00.000Z",
				to: "2026-08-01T00:00:00.000Z",
				value: 7,
			},
		]);
		expect(series.truncated).toBe(false);
	});

	it("steps month buckets across their uneven lengths", async () => {
		const series = await fetchUsageSummary({
			subscriptionId: "sub-1",
			metric: "input_tokens",
			window: "month",
			from: new Date("2026-01-15T00:00:00.000Z"),
			to: new Date("2026-04-01T00:00:00.000Z"),
		});

		expect(series.points.map((point) => point.from)).toEqual([
			"2026-01-01T00:00:00.000Z",
			"2026-02-01T00:00:00.000Z",
			"2026-03-01T00:00:00.000Z",
		]);
	});

	it("trims a range with more buckets than it can chart", async () => {
		const series = await fetchUsageSummary({
			subscriptionId: "sub-1",
			metric: "input_tokens",
			window: "hour",
			from: new Date("2026-01-01T00:00:00.000Z"),
			to: new Date("2026-12-31T00:00:00.000Z"),
		});

		expect(series.points).toHaveLength(1_000);
		expect(series.truncated).toBe(true);
	});
});
