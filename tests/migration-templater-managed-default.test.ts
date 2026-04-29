import { describe, expect, it } from "vitest";
import { migrateData } from "../src/settings-data";
import type { SyncedDatabase } from "../src/types";

describe("templater_managed migration", () => {
	it("adds a false default and remains idempotent at schema 7", () => {
		const migrated = migrateData({
			schemaVersion: 6,
			databases: [{
				id: "db-1",
				name: "Bugs",
				databaseId: "0123456789abcdef0123456789abcdef",
				outputFolder: "_relay/bugs",
				enabled: true,
				direction: "bidirectional",
				lastSyncedAt: "2026-04-29T10:00:00.000Z",
				lastSyncStatus: "ok",
				source_of_truth: "notion",
			} as Partial<SyncedDatabase> as SyncedDatabase],
		});
		const rerun = migrateData(migrated);

		expect(migrated.schemaVersion).toBe(7);
		expect(migrated.databases[0].templater_managed).toBe(false);
		expect(rerun).toEqual(migrated);
	});
});
