import { describe, expect, it } from "vitest";
import { buildDiagnosticsRows } from "../src/diagnostics-panel";
import { NotionFreezeSettings, SyncedDatabase } from "../src/types";

const rawId = "0123456789abcdef0123456789abcdef";

function database(overrides: Partial<SyncedDatabase> = {}): SyncedDatabase {
	return {
		id: overrides.id ?? "db-1",
		name: overrides.name ?? "Bugs DB",
		databaseId: overrides.databaseId ?? rawId,
		outputFolder: overrides.outputFolder ?? "3. System",
		errorLogFolder: overrides.errorLogFolder ?? "",
		groupId: overrides.groupId ?? null,
		autoSync: overrides.autoSync ?? "inherit",
		direction: overrides.direction ?? "bidirectional",
		enabled: overrides.enabled ?? true,
		lastSyncedAt: overrides.lastSyncedAt ?? null,
		lastSyncStatus: overrides.lastSyncStatus ?? "never",
		lastSyncError: overrides.lastSyncError,
		lastPulledAt: overrides.lastPulledAt ?? null,
		lastPushedAt: overrides.lastPushedAt ?? null,
		current_phase: overrides.current_phase ?? "phase_2",
		initial_seed_direction: overrides.initial_seed_direction ?? "pull",
		source_of_truth: overrides.source_of_truth ?? "notion",
		first_sync_completed_at: overrides.first_sync_completed_at ?? null,
		nest_under_db_name: overrides.nest_under_db_name ?? true,
		current_sync_id: overrides.current_sync_id ?? null,
		lastCommittedRowId: overrides.lastCommittedRowId ?? null,
		lastSyncErrors: overrides.lastSyncErrors ?? [],
	};
}

function settings(databases: SyncedDatabase[]): NotionFreezeSettings {
	return {
		apiKey: "",
		defaultOutputFolder: "_relay",
		defaultErrorLogFolder: "",
		databases,
		pages: [],
		groups: [],
		pendingConflicts: [],
		autoSyncEnabled: false,
		autoSyncDatabasesByDefault: false,
		autoSyncPagesByDefault: false,
		schemaVersion: 6,
	};
}

describe("diagnostics panel rows", () => {
	it("renders an empty state model for an empty database list", () => {
		expect(buildDiagnosticsRows(settings([]))).toEqual([]);
	});

	it("shows green readiness for a database with passable pull and push gates", () => {
		const data = settings([database({
			lastPulledAt: "2026-04-27T10:00:00.000Z",
			lastPushedAt: "2026-04-27T11:00:00.000Z",
		})]);

		expect(buildDiagnosticsRows(data)[0]).toMatchObject({
			pushReadiness: "PASS",
			pullReadiness: "PASS",
			pushSourceFolder: "3. System/Bugs DB",
			pullTargetFolder: "3. System/Bugs DB",
			lastPulledAt: "2026-04-27T10:00:00.000Z",
			lastPushedAt: "2026-04-27T11:00:00.000Z",
		});
	});

	it("shows BLOCKED with shared resolved content folder reasons", () => {
		const data = settings([
			database({ id: "bugs", name: "Bugs DB", outputFolder: "3. System", nest_under_db_name: false }),
			database({ id: "sessions", name: "Sessions DB", databaseId: "11111111111141118111111111111111", outputFolder: "3. System", nest_under_db_name: false }),
		]);

		expect(buildDiagnosticsRows(data)[0]).toMatchObject({
			pushReadiness: "BLOCKED",
		});
		expect(buildDiagnosticsRows(data)[0].pushReason).toContain("with Sessions DB");
		expect(buildDiagnosticsRows(data)[0].pushReason).toContain("shared resolved content folder");
	});

	it("shows stale-ID candidate counts with a threshold warning icon trigger", () => {
		const data = settings([database()]);

		expect(buildDiagnosticsRows(data, {
			staleIdCandidateCount: () => 6,
			duplicateNotionIdCount: () => 2,
			backfilledFileCount: () => 1,
		})[0]).toMatchObject({
			staleIdCandidateCount: 6,
			staleIdThresholdWarn: true,
			duplicateNotionIdCount: 2,
			backfilledFileCount: 1,
		});
	});
});
