import { describe, expect, it, vi } from "vitest";
import NotionFreezePlugin from "../src/main";
import * as notionClient from "../src/notion-client";
import type { SyncedDatabase } from "../src/types";
import { createTestReservationContext } from "./test-reservation-context";

describe("production reservation boundary", () => {
	it("rejects synthetic contexts at configured production entrypoints before Notion or vault work", async () => {
		const app = appMock();
		const plugin = new NotionFreezePlugin();
		plugin.app = app as never;
		plugin.settings = {
			...plugin.settings,
			apiKey: "test-key",
			databases: [entry()],
		};
		const createClient = vi.spyOn(notionClient, "createNotionClient");
		const context = createTestReservationContext("bare-string");

		await expect(plugin.syncConfiguredDatabase(entry(), "_relay/bugs", { context }))
			.rejects.toThrow("Reservation required before configured database pull");
		await expect(plugin.pushConfiguredDatabase(entry(), "_relay/bugs", { context }))
			.rejects.toThrow("Reservation required before configured database push");

		expect(createClient).not.toHaveBeenCalled();
		expect(app.vault.getMarkdownFiles).not.toHaveBeenCalled();
		expect(app.vault.getAbstractFileByPath).not.toHaveBeenCalled();
		expect(app.vault.adapter.write).not.toHaveBeenCalled();
	});
});

function entry(): SyncedDatabase {
	return {
		id: "db-1",
		name: "Bugs DB",
		databaseId: "0123456789abcdef0123456789abcdef",
		outputFolder: "_relay/bugs",
		errorLogFolder: "",
		groupId: null,
		autoSync: "inherit",
		direction: "pull",
		enabled: true,
		lastSyncedAt: null,
		lastSyncStatus: "never",
		lastPulledAt: null,
		lastPushedAt: null,
		current_phase: "phase_1",
		initial_seed_direction: null,
		source_of_truth: null,
		first_sync_completed_at: null,
		nest_under_db_name: true,
		current_sync_id: null,
		lastCommittedRowId: null,
		lastSyncErrors: [],
	};
}

function appMock() {
	return {
		vault: {
			getMarkdownFiles: vi.fn(() => []),
			getAbstractFileByPath: vi.fn(),
			adapter: {
				write: vi.fn(),
			},
		},
		metadataCache: {
			getFileCache: vi.fn(),
		},
		workspace: {
			trigger: vi.fn(),
		},
	};
}
