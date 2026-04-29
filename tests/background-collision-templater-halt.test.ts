import { describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import NotionFreezePlugin from "../src/main";
import type { SyncedDatabase } from "../src/types";

describe("Templater-managed background collision detection", () => {
	it("halts on vault-only changes for templater-managed database entries", () => {
		const plugin = new NotionFreezePlugin();
		plugin.app = {
			metadataCache: {
				getFileCache: vi.fn(() => ({
					frontmatter: {
						"notion-id": "page-1",
						"notion-last-edited": "2026-04-29T10:00:00.000Z",
					},
				})),
			},
		} as never;

		const conflict = (plugin as unknown as {
			detectBackgroundCollision(entry: SyncedDatabase, file: TFile): unknown;
		}).detectBackgroundCollision(database(), file("_relay/bugs/Row.md"));

		expect(conflict).toMatchObject({
			entryId: "db-1",
			entryType: "database",
			rowId: "page-1",
		});
	});
});

function database(): SyncedDatabase {
	return {
		id: "db-1",
		name: "Bugs",
		databaseId: "0123456789abcdef0123456789abcdef",
		outputFolder: "_relay/bugs",
		errorLogFolder: "",
		groupId: null,
		autoSync: "inherit",
		direction: "bidirectional",
		enabled: true,
		lastSyncedAt: "2026-04-29T10:00:00.000Z",
		lastSyncStatus: "ok",
		lastPulledAt: "2026-04-29T10:00:00.000Z",
		lastPushedAt: null,
		current_phase: "phase_2",
		initial_seed_direction: "pull",
		source_of_truth: "notion",
		templater_managed: true,
		first_sync_completed_at: "2026-04-29T10:00:00.000Z",
		nest_under_db_name: true,
		current_sync_id: null,
		lastCommittedRowId: null,
		lastSyncErrors: [],
	};
}

function file(path: string): TFile {
	return Object.assign(Object.create(TFile.prototype), {
		path,
		name: "Row.md",
		basename: "Row",
		extension: "md",
		stat: { mtime: Date.parse("2026-04-29T10:05:00.000Z") },
	});
}
