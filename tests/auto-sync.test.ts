import { describe, expect, it, vi } from "vitest";
import { AutoSyncQueue, createBackgroundConflict, findAutoSyncEntryForPath, isAutoSyncEligible } from "../src/auto-sync";
import { NotionFreezeSettings, PageSyncEntry, SyncedDatabase } from "../src/types";

function database(overrides: Partial<SyncedDatabase> = {}): SyncedDatabase {
	return {
		id: overrides.id ?? "db-1",
		name: overrides.name ?? "DB",
		databaseId: overrides.databaseId ?? "0123456789abcdef0123456789abcdef",
		outputFolder: overrides.outputFolder ?? "_relay/db",
		errorLogFolder: overrides.errorLogFolder ?? "",
		groupId: overrides.groupId ?? null,
		autoSync: overrides.autoSync ?? "inherit",
		direction: overrides.direction ?? "bidirectional",
		enabled: overrides.enabled ?? true,
		lastSyncedAt: overrides.lastSyncedAt ?? "2026-04-27T10:00:00.000Z",
		lastSyncStatus: overrides.lastSyncStatus ?? "ok",
		lastSyncError: overrides.lastSyncError,
		lastPulledAt: overrides.lastPulledAt ?? null,
		lastPushedAt: overrides.lastPushedAt ?? null,
		current_phase: overrides.current_phase ?? "phase_2",
		initial_seed_direction: overrides.initial_seed_direction ?? "pull",
		source_of_truth: overrides.source_of_truth ?? "notion",
		first_sync_completed_at: overrides.first_sync_completed_at ?? "2026-04-27T10:00:00.000Z",
		nest_under_db_name: overrides.nest_under_db_name ?? true,
		current_sync_id: overrides.current_sync_id ?? null,
		lastCommittedRowId: overrides.lastCommittedRowId ?? null,
		lastSyncErrors: overrides.lastSyncErrors ?? [],
	};
}

function page(overrides: Partial<PageSyncEntry> = {}): PageSyncEntry {
	return {
		id: overrides.id ?? "page-1",
		type: "page",
		name: overrides.name ?? "Page",
		pageId: overrides.pageId ?? "fedcba9876543210fedcba9876543210",
		outputFolder: overrides.outputFolder ?? "_relay",
		errorLogFolder: overrides.errorLogFolder ?? "",
		groupId: overrides.groupId ?? null,
		enabled: overrides.enabled ?? true,
		autoSync: overrides.autoSync ?? "inherit",
		lastSyncedAt: overrides.lastSyncedAt ?? "2026-04-27T10:00:00.000Z",
		lastSyncStatus: overrides.lastSyncStatus ?? "ok",
		lastSyncError: overrides.lastSyncError,
		current_sync_id: overrides.current_sync_id ?? null,
		lastFilePath: overrides.lastFilePath ?? "_relay/Exact Page.md",
	};
}

function settings(entry = database(), pages: PageSyncEntry[] = []): NotionFreezeSettings {
	return {
		apiKey: "ntn_test",
		defaultOutputFolder: "_relay",
		defaultErrorLogFolder: "",
		databases: [entry],
		pages,
		groups: [],
		pendingConflicts: [],
		autoSyncEnabled: true,
		autoSyncDatabasesByDefault: true,
		autoSyncPagesByDefault: false,
		schemaVersion: 5,
	};
}

describe("auto-sync eligibility", () => {
	it("blocks global off, per-entry off, pending conflicts, blocked statuses, and active syncs", () => {
		const entry = database();

		expect(isAutoSyncEligible({ ...settings(entry), autoSyncEnabled: false }, { type: "database", entry })).toBe(false);
		expect(isAutoSyncEligible(settings(database({ autoSync: "off" })), { type: "database", entry: database({ autoSync: "off" }) })).toBe(false);
		expect(isAutoSyncEligible({ ...settings(entry), pendingConflicts: [createBackgroundConflict({
			entryId: entry.id,
			entryType: "database",
			rowId: "row-1",
			notionEditedAt: "2026-04-27T10:01:00.000Z",
			vaultEditedAt: "2026-04-27T10:02:00.000Z",
		})] }, { type: "database", entry })).toBe(false);
		expect(isAutoSyncEligible(settings(database({ lastSyncStatus: "partial" })), { type: "database", entry: database({ lastSyncStatus: "partial" }) })).toBe(false);
		expect(isAutoSyncEligible(settings(database({ current_sync_id: "sync-1" })), { type: "database", entry: database({ current_sync_id: "sync-1" }) })).toBe(false);
		expect(isAutoSyncEligible(settings(database({ autoSync: "on" })), { type: "database", entry: database({ autoSync: "on" }) })).toBe(false);
	});

	it("keeps database background auto-sync disabled until row-scoped push exists", () => {
		expect(isAutoSyncEligible(settings(database({ autoSync: "on", lastSyncStatus: "ok" })), {
			type: "database",
			entry: database({ autoSync: "on", lastSyncStatus: "ok" }),
		})).toBe(false);
	});

	it("finds configured entries by vault path", () => {
		expect(findAutoSyncEntryForPath(settings(), "_relay/db/DB/Note.md")).toMatchObject({
			type: "database",
			entry: { id: "db-1" },
		});
		expect(findAutoSyncEntryForPath(settings(), "elsewhere/Note.md")).toBeNull();
	});

	it("uses resolved database content folders and prefers exact standalone page files", () => {
		const db = database({ id: "db-1", outputFolder: "_relay", name: "Exact Page" });
		const exactPage = page({ id: "page-1", outputFolder: "_relay", lastFilePath: "_relay/Exact Page.md" });

		expect(findAutoSyncEntryForPath(settings(db, [exactPage]), "_relay/Exact Page.md")).toMatchObject({
			type: "page",
			entry: { id: "page-1" },
		});
		expect(findAutoSyncEntryForPath(settings(db, [exactPage]), "_relay/Exact Page/Row.md")).toMatchObject({
			type: "database",
			entry: { id: "db-1" },
		});
	});
});

describe("auto-sync queue", () => {
	it("debounces and collapses duplicate queued jobs", async () => {
		vi.useFakeTimers();
		const runner = vi.fn().mockResolvedValue(undefined);
		const queue = new AutoSyncQueue(runner, 100);

		queue.enqueue({ entryId: "db-1", entryType: "database", path: "_relay/db/A.md", runType: "push" });
		queue.enqueue({ entryId: "db-1", entryType: "database", path: "_relay/db/A.md", runType: "push" });
		expect(queue.size()).toBe(1);

		await vi.advanceTimersByTimeAsync(100);
		expect(runner).toHaveBeenCalledTimes(1);
		expect(runner).toHaveBeenCalledWith({ entryId: "db-1", entryType: "database", path: "_relay/db/A.md", runType: "push" });
		vi.useRealTimers();
	});
});
