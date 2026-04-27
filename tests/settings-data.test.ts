import { describe, expect, it } from "vitest";
import {
	addDatabase,
	addGroup,
	addPage,
	effectiveAutoSyncEnabled,
	migrateData,
	removeDatabase,
	removeGroup,
	resolveDatabaseContentFolder,
	resolveErrorLogFolder,
	resolveOutputFolder,
	sharedOutputFolderDatabases,
	syncAll,
} from "../src/settings-data";
import { NotionFreezeSettings, PageSyncEntry, SyncedDatabase } from "../src/types";

const rawId = "5123456789ab4def8123456789abcdef";
const dashedId = "51234567-89ab-4def-8123-456789abcdef";

function settings(databases: SyncedDatabase[] = []): NotionFreezeSettings {
	return {
		apiKey: "ntn_test",
		defaultOutputFolder: "_relay",
		defaultErrorLogFolder: "",
		databases,
		pages: [],
		groups: [],
		pendingConflicts: [],
		autoSyncEnabled: false,
		autoSyncDatabasesByDefault: false,
		autoSyncPagesByDefault: false,
		schemaVersion: 4,
	};
}

function database(overrides: Partial<SyncedDatabase> = {}): SyncedDatabase {
	return {
		id: overrides.id ?? crypto.randomUUID(),
		name: overrides.name ?? "Sessions Mirror",
		databaseId: overrides.databaseId ?? dashedId,
		outputFolder: overrides.outputFolder ?? "3. System/Sessions",
		errorLogFolder: overrides.errorLogFolder ?? "",
		direction: overrides.direction ?? "pull",
		enabled: overrides.enabled ?? true,
		lastSyncedAt: overrides.lastSyncedAt ?? null,
		lastSyncStatus: overrides.lastSyncStatus ?? "never",
		lastSyncError: overrides.lastSyncError,
		lastPulledAt: overrides.lastPulledAt ?? overrides.lastSyncedAt ?? null,
		lastPushedAt: overrides.lastPushedAt ?? null,
		current_phase: overrides.current_phase ?? "phase_1",
		initial_seed_direction: overrides.initial_seed_direction ?? null,
		source_of_truth: overrides.source_of_truth ?? null,
		first_sync_completed_at: overrides.first_sync_completed_at ?? null,
		nest_under_db_name: overrides.nest_under_db_name ?? true,
		current_sync_id: overrides.current_sync_id ?? null,
		lastCommittedRowId: overrides.lastCommittedRowId ?? null,
		lastSyncErrors: overrides.lastSyncErrors ?? [],
		groupId: overrides.groupId ?? null,
		autoSync: overrides.autoSync ?? "inherit",
	};
}

function page(overrides: Partial<PageSyncEntry> = {}): PageSyncEntry {
	return {
		id: overrides.id ?? crypto.randomUUID(),
		type: "page",
		name: overrides.name ?? "Standalone Page",
		pageId: overrides.pageId ?? rawId,
		outputFolder: overrides.outputFolder ?? "_relay/pages",
		errorLogFolder: overrides.errorLogFolder ?? "",
		groupId: overrides.groupId ?? null,
		enabled: overrides.enabled ?? true,
		autoSync: overrides.autoSync ?? "inherit",
		lastSyncedAt: overrides.lastSyncedAt ?? null,
		lastSyncStatus: overrides.lastSyncStatus ?? "never",
		lastSyncError: overrides.lastSyncError,
		current_sync_id: overrides.current_sync_id ?? null,
		lastFilePath: overrides.lastFilePath ?? null,
	};
}

describe("settings data migration", () => {
	it("adds databases and schemaVersion when missing", () => {
		const migrated = migrateData({
			apiKey: "ntn_existing",
			defaultOutputFolder: "Notion",
		});

		expect(migrated.apiKey).toBe("ntn_existing");
		expect(migrated.defaultOutputFolder).toBe("Notion");
		expect(migrated.databases).toEqual([]);
		expect(migrated.schemaVersion).toBe(5);
		expect(migrated.pendingConflicts).toEqual([]);
		expect(migrated.groups).toEqual([]);
		expect(migrated.pages).toEqual([]);
		expect(migrated.autoSyncEnabled).toBe(false);
	});

	it("is idempotent on already migrated data", () => {
		const db = database({ id: "stable-id" });
		const migrated = migrateData(settings([db]));

		expect(migrated.databases).toHaveLength(1);
		expect(migrated.databases[0]).toEqual({
			...db,
			databaseId: rawId,
			direction: "pull",
			lastPulledAt: null,
			lastPushedAt: null,
			groupId: null,
			autoSync: "inherit",
		});
		expect(migrated.schemaVersion).toBe(5);
	});

	it("migrates v0.5 entries to schema 3 without data loss", () => {
		const migrated = migrateData({
			apiKey: "ntn_existing",
			defaultOutputFolder: "_relay",
			schemaVersion: 2,
			databases: [{
				id: "db-1",
				name: "Bugs",
				databaseId: dashedId,
				outputFolder: "_relay/bugs",
				enabled: true,
				lastSyncedAt: "2026-04-24T10:00:00.000Z",
				lastSyncStatus: "ok",
			} as SyncedDatabase],
		});

		expect(migrated.schemaVersion).toBe(5);
		expect(migrated.databases[0]).toMatchObject({
			id: "db-1",
			name: "Bugs",
			databaseId: rawId,
			outputFolder: "_relay/bugs",
			direction: "pull",
			lastSyncedAt: "2026-04-24T10:00:00.000Z",
			lastPulledAt: "2026-04-24T10:00:00.000Z",
			lastPushedAt: null,
			current_phase: "phase_2",
			initial_seed_direction: "pull",
			source_of_truth: "notion",
			first_sync_completed_at: "2026-04-24T10:00:00.000Z",
			nest_under_db_name: true,
			current_sync_id: null,
			lastCommittedRowId: null,
			lastSyncErrors: [],
			groupId: null,
			autoSync: "inherit",
		});
	});

	it("migrates unsynced v0.6 entries to phase 1", () => {
		const migrated = migrateData({
			apiKey: "ntn_existing",
			defaultOutputFolder: "_relay",
			schemaVersion: 3,
			databases: [database({ id: "db-1", direction: "push", lastSyncedAt: null })],
		});

		expect(migrated.databases[0]).toMatchObject({
			current_phase: "phase_1",
			initial_seed_direction: null,
			source_of_truth: null,
			first_sync_completed_at: null,
			nest_under_db_name: true,
			current_sync_id: null,
			lastCommittedRowId: null,
			lastSyncErrors: [],
		});
	});
});

describe("shared output folder detection", () => {
	it("finds databases that would push from the same folder", () => {
		const bugs = database({ id: "bugs", name: "Bugs", outputFolder: "3. System/" });
		const people = database({ id: "people", name: "People", outputFolder: "3. System" });
		const projects = database({ id: "projects", name: "Projects", outputFolder: "1. Projects" });

		expect(sharedOutputFolderDatabases(settings([bugs, people, projects]), bugs).map((entry) => entry.name)).toEqual(["People"]);
	});

	it("uses the resolved default folder when entry folders are blank", () => {
		const first = database({ id: "first", outputFolder: "" });
		const second = database({ id: "second", outputFolder: "" });

		expect(sharedOutputFolderDatabases(settings([first, second]), first).map((entry) => entry.id)).toEqual(["second"]);
	});
});

describe("schema 5 groups, pages, and auto-sync settings", () => {
	it("migrates v0.8.1 database entries without losing fields", () => {
		const migrated = migrateData(settings([database({ id: "db-1", autoSync: undefined, groupId: undefined })]));

		expect(migrated.schemaVersion).toBe(5);
		expect(migrated.databases[0]).toMatchObject({
			id: "db-1",
			groupId: null,
			autoSync: "inherit",
		});
		expect(migrated.pages).toEqual([]);
		expect(migrated.groups).toEqual([]);
	});

	it("adds pages and groups, and deleting a group moves entries to Ungrouped", () => {
		let current = addGroup(settings(), "Active");
		const groupId = current.groups[0].id;
		current = addDatabase(current, {
			...database({ id: "db-1", groupId }),
			databaseId: rawId,
		});
		current = addPage(current, page({ id: "page-1", groupId }));

		const removed = removeGroup(current, groupId);
		expect(removed.groups).toHaveLength(0);
		expect(removed.databases[0].groupId).toBeNull();
		expect(removed.pages[0].groupId).toBeNull();
	});

	it("resolves global/default/per-entry auto-sync state", () => {
		const base = {
			...settings(),
			autoSyncEnabled: true,
			autoSyncDatabasesByDefault: false,
			autoSyncPagesByDefault: true,
		};

		expect(effectiveAutoSyncEnabled({ ...base, autoSyncEnabled: false }, database({ autoSync: "on" }), "database")).toBe(false);
		expect(effectiveAutoSyncEnabled(base, database({ autoSync: "off" }), "database")).toBe(false);
		expect(effectiveAutoSyncEnabled(base, database({ autoSync: "on" }), "database")).toBe(true);
		expect(effectiveAutoSyncEnabled(base, database({ autoSync: "inherit" }), "database")).toBe(false);
		expect(effectiveAutoSyncEnabled(base, page({ autoSync: "inherit" }), "page")).toBe(true);
	});
});

describe("database list operations", () => {
	it("addDatabase appends and generates an id when missing", () => {
		const updated = addDatabase(settings(), {
			name: "Sessions Mirror",
			databaseId: rawId,
			outputFolder: "3. System/Sessions",
		});

		expect(updated.databases).toHaveLength(1);
		expect(updated.databases[0].id).toBeTruthy();
		expect(updated.databases[0].databaseId).toBe(rawId);
		expect(updated.databases[0].direction).toBe("pull");
	});

	it("removeDatabase removes by id and no-ops on unknown id", () => {
		const first = database({ id: "one", name: "One" });
		const second = database({ id: "two", name: "Two" });
		const initial = settings([first, second]);

		expect(removeDatabase(initial, "one").databases).toEqual([second]);
		expect(removeDatabase(initial, "missing").databases).toEqual([first, second]);
	});
});

describe("syncAll", () => {
	it("filters enabled databases, runs sequentially, and captures success/error", async () => {
		const first = database({ id: "one", name: "One" });
		const second = database({ id: "two", name: "Two", enabled: false });
		const third = database({ id: "three", name: "Three" });
		const calls: string[] = [];

		const result = await syncAll(settings([first, second, third]), async (entry) => {
			calls.push(entry.id);
			if (entry.id === "three") throw new Error("No access to database");
		});

		expect(calls).toEqual(["one", "three"]);
		expect(result.ok).toBe(1);
		expect(result.errored).toBe(1);
		expect(result.settings.databases[0].lastSyncStatus).toBe("ok");
		expect(result.settings.databases[0].lastSyncedAt).toBeTruthy();
		expect(result.settings.databases[0].lastPulledAt).toBeTruthy();
		expect(result.settings.databases[1].lastSyncStatus).toBe("never");
		expect(result.settings.databases[2].lastSyncStatus).toBe("error");
		expect(result.settings.databases[2].lastSyncError).toBe("No access to database");
	});

	it("push mode only runs push and bidirectional databases", async () => {
		const pull = database({ id: "pull", direction: "pull" });
		const push = database({ id: "push", direction: "push" });
		const both = database({ id: "both", direction: "bidirectional" });
		const calls: string[] = [];

		const result = await syncAll(settings([pull, push, both]), async (entry) => {
			calls.push(entry.id);
		}, undefined, "push");

		expect(calls).toEqual(["push", "both"]);
		expect(result.settings.databases[0].lastPushedAt).toBeNull();
		expect(result.settings.databases[1].lastPushedAt).toBeTruthy();
		expect(result.settings.databases[2].lastPushedAt).toBeTruthy();
	});

	it("marks sync results with row failures as partial", async () => {
		const first = database({ id: "one", name: "One" });
		const result = await syncAll(settings([first]), async () => ({
			failed: 1,
			errors: ["row-1: Notion rejected row"],
		}));

		expect(result.settings.databases[0].lastSyncStatus).toBe("partial");
		expect(result.settings.databases[0].lastSyncErrors).toHaveLength(1);
		expect(result.settings.databases[0].lastSyncErrors[0].rowId).toBe("row-1");
	});

	it("shows a notice when no enabled databases exist", async () => {
		const notices: string[] = [];
		const result = await syncAll(
			settings([database({ enabled: false })]),
			async () => {
				throw new Error("should not run");
			},
			(message) => notices.push(message)
		);

		expect(result.ok).toBe(0);
		expect(result.errored).toBe(0);
		expect(notices).toEqual(["No enabled databases to pull."]);
	});
});

describe("output folder resolution", () => {
	it("falls back from per-db folder to default to _relay", () => {
		expect(resolveOutputFolder(settings(), database({ outputFolder: "" }))).toBe("_relay");
		expect(resolveOutputFolder({ ...settings(), defaultOutputFolder: "" }, database({ outputFolder: "" }))).toBe("_relay");
		expect(resolveOutputFolder(settings(), database({ outputFolder: "Custom" }))).toBe("Custom");
	});

	it("resolves the actual database content folder when nesting is enabled", () => {
		expect(resolveDatabaseContentFolder(settings(), database({
			name: "Bugs DB",
			outputFolder: "3. System/",
			nest_under_db_name: true,
		}))).toBe("3. System/Bugs DB");
			expect(resolveDatabaseContentFolder(settings(), database({
				name: "Bugs DB",
				outputFolder: "3. System/",
				nest_under_db_name: false,
			}))).toBe("3. System");
		});
	});

describe("error log folder resolution", () => {
	it("prefers per-db override, then global default, then UI-only null", () => {
		expect(resolveErrorLogFolder(
			{ ...settings(), defaultErrorLogFolder: "_relay/errors" },
			database({ errorLogFolder: "_relay/db-errors" })
		)).toBe("_relay/db-errors");
		expect(resolveErrorLogFolder(
			{ ...settings(), defaultErrorLogFolder: "_relay/errors" },
			database({ errorLogFolder: "" })
		)).toBe("_relay/errors");
		expect(resolveErrorLogFolder(settings(), database({ errorLogFolder: "" }))).toBeNull();
	});
});
