import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, test } from "vitest";
import { createDatabaseEntry, migrateData } from "../src/settings-data";
import { applyPhaseTransition } from "../src/sync-state";

const rawId = "5123456789ab4def8123456789abcdef";

describe("phase transitions", () => {
	test("Add Database creates entry in phase_1", () => {
		const entry = createDatabaseEntry({
			name: "Sessions",
			databaseId: rawId,
			direction: "pull",
			initial_seed_direction: "pull",
		});

		expect(entry.current_phase).toBe("phase_1");
		expect(entry.initial_seed_direction).toBe("pull");
		expect(entry.source_of_truth).toBeNull();
	});

	test("first successful sync transitions phase_1 to phase_2", () => {
		const entry = createDatabaseEntry({
			name: "Sessions",
			databaseId: rawId,
			direction: "pull",
			initial_seed_direction: "pull",
		});
		const transitioned = applyPhaseTransition(entry, "ok", [], "full", "2026-04-25T21:00:00.000Z");

		expect(transitioned.current_phase).toBe("phase_2");
		expect(transitioned.first_sync_completed_at).toBe("2026-04-25T21:00:00.000Z");
		expect(transitioned.source_of_truth).toBe("notion");
	});

	test("partial, cancelled, error, and retry runs stay in phase_1", () => {
		const entry = createDatabaseEntry({
			name: "Sessions",
			databaseId: rawId,
			direction: "push",
			initial_seed_direction: "push",
		});
		const error = { rowId: "row-1", direction: "pull" as const, error: "row failed", timestamp: "2026-04-25T21:00:00.000Z" };

		expect(applyPhaseTransition(entry, "partial", [error], "full", "now").current_phase).toBe("phase_1");
		expect(applyPhaseTransition(entry, "cancelled", [], "full", "now").current_phase).toBe("phase_1");
		expect(applyPhaseTransition(entry, "error", [], "full", "now").current_phase).toBe("phase_1");
		expect(applyPhaseTransition(entry, "ok", [], "retry", "now").current_phase).toBe("phase_1");
	});

	test("schema migration: legacy v0.6 entry with lastSyncedAt becomes phase_2", () => {
		const migrated = migrateData({
			apiKey: "ntn_test",
			defaultOutputFolder: "_relay",
			schemaVersion: 3,
			databases: [{
				id: "db-1",
				name: "Bugs",
				databaseId: rawId,
				outputFolder: "_relay/bugs",
				direction: "push",
				enabled: true,
				lastSyncedAt: "2026-04-25T20:00:00.000Z",
				lastSyncStatus: "ok",
			} as never],
		});

		expect(migrated.schemaVersion).toBe(7);
		expect(migrated.databases[0]).toMatchObject({
			current_phase: "phase_2",
			initial_seed_direction: "push",
			source_of_truth: "obsidian",
			first_sync_completed_at: "2026-04-25T20:00:00.000Z",
			nest_under_db_name: true,
			templater_managed: false,
			current_sync_id: null,
			lastCommittedRowId: null,
			lastSyncErrors: [],
		});
	});

	test("schema migration: legacy v0.6 entry without lastSyncedAt becomes phase_1", () => {
		const migrated = migrateData({
			apiKey: "ntn_test",
			defaultOutputFolder: "_relay",
			schemaVersion: 3,
			databases: [{
				id: "db-1",
				name: "Bugs",
				databaseId: rawId,
				outputFolder: "_relay/bugs",
				direction: "pull",
				enabled: true,
				lastSyncedAt: null,
				lastSyncStatus: "never",
			} as never],
		});

		expect(migrated.databases[0]).toMatchObject({
			current_phase: "phase_1",
			initial_seed_direction: null,
			source_of_truth: null,
			first_sync_completed_at: null,
		});
	});

	test("schema migration fixture produces correct phase defaults", () => {
		const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures/legacy-v06-entries.json"), "utf8"));
		const migrated = migrateData(fixture);

		expect(migrated.databases[0]).toMatchObject({
			current_phase: "phase_2",
			source_of_truth: "notion",
			nest_under_db_name: true,
			templater_managed: false,
			current_sync_id: null,
			lastCommittedRowId: null,
			lastSyncErrors: [],
		});
		expect(migrated.databases[1]).toMatchObject({
			current_phase: "phase_1",
			initial_seed_direction: null,
			source_of_truth: null,
		});
	});
});
