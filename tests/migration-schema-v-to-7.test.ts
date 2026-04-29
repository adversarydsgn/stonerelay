import { describe, expect, it } from "vitest";
import { migrateData } from "../src/settings-data";

describe("vault canonical schema migration", () => {
	it("adds canonical ID fields to existing database entries", () => {
		const migrated = migrateData({
			schemaVersion: 6,
			databases: [{ id: "db-1", name: "Bugs", databaseId: "0123456789abcdef0123456789abcdef" } as never],
		});

		expect(migrated.schemaVersion).toBe(7);
		expect(migrated.databases[0]).toMatchObject({
			canonical_id_property: null,
			last_observed_unique_id_max: null,
		});
	});
});
