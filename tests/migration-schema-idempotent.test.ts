import { describe, expect, it } from "vitest";
import { migrateData } from "../src/settings-data";

describe("vault canonical schema migration idempotency", () => {
	it("produces identical state when run twice", () => {
		const once = migrateData({
			schemaVersion: 6,
			databases: [{ id: "db-1", name: "Bugs", databaseId: "0123456789abcdef0123456789abcdef" } as never],
		});
		const twice = migrateData(once);

		expect(twice).toEqual(once);
	});
});
