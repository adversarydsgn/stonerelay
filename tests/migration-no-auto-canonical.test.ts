import { describe, expect, it } from "vitest";
import { migrateData } from "../src/settings-data";

describe("vault canonical schema migration no auto configuration", () => {
	it("does not infer or set canonical_id_property", () => {
		const migrated = migrateData({
			schemaVersion: 6,
			databases: [{ id: "db-1", name: "Bugs", databaseId: "0123456789abcdef0123456789abcdef" } as never],
		});

		expect(migrated.databases[0].canonical_id_property).toBeNull();
	});
});
