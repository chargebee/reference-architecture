import { describe, expect, it } from "vitest";

import { UsageStoreType, usageStoreType } from "./store";

describe("usageStoreType", () => {
	it("defaults to PostgreSQL", () => {
		expect(usageStoreType(undefined)).toBe(UsageStoreType.Postgres);
		expect(usageStoreType("postgres")).toBe(UsageStoreType.Postgres);
	});

	it("selects S3 explicitly", () => {
		expect(usageStoreType("s3")).toBe(UsageStoreType.S3);
	});

	it("rejects unknown stores", () => {
		expect(() => usageStoreType("both")).toThrow(
			'USAGE_METRICS_STORE must be "postgres" or "s3"',
		);
	});
});
