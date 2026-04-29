import { describe, expect, it } from "vitest";
import { migrateData } from "../src/settings-data";

describe("vault canonical settings migration noop", () => {
	it("preserves existing DBs as unmigrated by default", () => {
		const migrated = migrateData({
			schemaVersion: 6,
			databases: [{ id: "db-1", name: "Bugs", databaseId: "0123456789abcdef0123456789abcdef" } as never],
		});

		expect(migrated.databases[0].canonical_id_property).toBeNull();
		expect(migrated.databases[0].last_observed_unique_id_max).toBeNull();
	});
});
