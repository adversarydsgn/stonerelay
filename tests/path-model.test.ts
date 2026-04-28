import { describe, expect, it } from "vitest";
import {
	isSafeVaultRelativePath,
	resolveDatabasePathModel,
	resolvePagePathModel,
	validateVaultFolderPath,
} from "../src/path-model";
import { NotionFreezeSettings, PageSyncEntry, SyncedDatabase } from "../src/types";

function settings(databases: SyncedDatabase[] = []): NotionFreezeSettings {
	return {
		apiKey: "",
		defaultOutputFolder: "_relay",
		defaultErrorLogFolder: "_relay/errors",
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

function database(overrides: Partial<SyncedDatabase> = {}): SyncedDatabase {
	return {
		id: overrides.id ?? "db-1",
		name: overrides.name ?? "Bugs DB",
		databaseId: overrides.databaseId ?? "0123456789abcdef0123456789abcdef",
		outputFolder: overrides.outputFolder ?? "3. System/",
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

function page(overrides: Partial<PageSyncEntry> = {}): PageSyncEntry {
	return {
		id: overrides.id ?? "page-1",
		type: "page",
		name: overrides.name ?? "Page",
		pageId: overrides.pageId ?? "fedcba9876543210fedcba9876543210",
		outputFolder: overrides.outputFolder ?? "_relay/pages",
		errorLogFolder: overrides.errorLogFolder ?? "",
		groupId: overrides.groupId ?? null,
		enabled: overrides.enabled ?? true,
		autoSync: overrides.autoSync ?? "inherit",
		lastSyncedAt: overrides.lastSyncedAt ?? null,
		lastSyncStatus: overrides.lastSyncStatus ?? "never",
		lastSyncError: overrides.lastSyncError,
		current_sync_id: overrides.current_sync_id ?? null,
		lastFilePath: overrides.lastFilePath ?? "_relay/pages/Page.md",
	};
}

describe("central path model", () => {
	it("resolves configured parent, content folder, discovered folder, push source, pull target, and error log", () => {
		const entry = database({ errorLogFolder: "_relay/bugs-errors" });
		expect(resolveDatabasePathModel(settings([entry]), entry, {
			discoveredContentFolder: "3. System/Bugs DB",
		})).toEqual({
			configuredParentFolder: "3. System",
			databaseContentFolder: "3. System/Bugs DB",
			existingDiscoveredContentFolder: "3. System/Bugs DB",
			pushSourceFolder: "3. System/Bugs DB",
			pullTargetFolder: "3. System/Bugs DB",
			errorLogFolder: "_relay/bugs-errors",
		});
	});

	it("resolves shared parent folders into distinct database content folders", () => {
		const bugs = database({ id: "bugs", name: "Bugs DB", outputFolder: "3. System/" });
		const sessions = database({ id: "sessions", name: "Sessions DB", outputFolder: "3. System" });

		expect(resolveDatabasePathModel(settings([bugs, sessions]), bugs).databaseContentFolder).toBe("3. System/Bugs DB");
		expect(resolveDatabasePathModel(settings([bugs, sessions]), sessions).databaseContentFolder).toBe("3. System/Sessions DB");
	});

	it("resolves standalone page parent folder and exact page file path", () => {
		expect(resolvePagePathModel(settings(), page())).toEqual({
			pageParentFolder: "_relay/pages",
			pageFilePath: "_relay/pages/Page.md",
			errorLogFolder: "_relay/errors",
		});
	});

	it("rejects path traversal and absolute configured folders", () => {
		expect(validateVaultFolderPath("../outside")).toMatchObject({ ok: false });
		expect(validateVaultFolderPath("/Users/adversary/Vault")).toMatchObject({ ok: false });
		expect(validateVaultFolderPath("C:\\Vault")).toMatchObject({ ok: false });
		expect(isSafeVaultRelativePath("3. System/Bugs DB")).toBe(true);
	});
});
