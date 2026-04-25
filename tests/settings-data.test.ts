import { describe, expect, it } from "vitest";
import {
	addDatabase,
	migrateData,
	removeDatabase,
	resolveOutputFolder,
	syncAll,
} from "../src/settings-data";
import { NotionFreezeSettings, SyncedDatabase } from "../src/types";

const rawId = "5123456789ab4def8123456789abcdef";
const dashedId = "51234567-89ab-4def-8123-456789abcdef";

function settings(databases: SyncedDatabase[] = []): NotionFreezeSettings {
	return {
		apiKey: "ntn_test",
		defaultOutputFolder: "_relay",
		databases,
		schemaVersion: 3,
	};
}

function database(overrides: Partial<SyncedDatabase> = {}): SyncedDatabase {
	return {
		id: overrides.id ?? crypto.randomUUID(),
		name: overrides.name ?? "Sessions Mirror",
		databaseId: overrides.databaseId ?? dashedId,
		outputFolder: overrides.outputFolder ?? "3. System/Sessions",
		direction: overrides.direction ?? "pull",
		enabled: overrides.enabled ?? true,
		lastSyncedAt: overrides.lastSyncedAt ?? null,
		lastSyncStatus: overrides.lastSyncStatus ?? "never",
		lastSyncError: overrides.lastSyncError,
		lastPulledAt: overrides.lastPulledAt ?? overrides.lastSyncedAt ?? null,
		lastPushedAt: overrides.lastPushedAt ?? null,
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
		expect(migrated.schemaVersion).toBe(3);
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
		});
		expect(migrated.schemaVersion).toBe(3);
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

		expect(migrated.schemaVersion).toBe(3);
		expect(migrated.databases[0]).toMatchObject({
			id: "db-1",
			name: "Bugs",
			databaseId: rawId,
			outputFolder: "_relay/bugs",
			direction: "pull",
			lastSyncedAt: "2026-04-24T10:00:00.000Z",
			lastPulledAt: "2026-04-24T10:00:00.000Z",
			lastPushedAt: null,
		});
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
});
