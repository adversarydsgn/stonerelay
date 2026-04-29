import { describe, expect, it } from "vitest";
import { Notice } from "obsidian";
import NotionFreezePlugin from "../src/main";
import { ReservationManager } from "../src/reservations";
import { migrateData } from "../src/settings-data";
import { SyncedDatabase } from "../src/types";

describe("batch reservation integration", () => {
	it("does not block unrelated Sync All entries behind a queued busy entry and records queued cancellation", async () => {
		const first = database({ id: "first", name: "First", databaseId: "11111111111141118111111111111111", outputFolder: "_relay/first" });
		const second = database({ id: "second", name: "Second", databaseId: "22222222222242228222222222222222", outputFolder: "_relay/second" });
		const plugin = Object.create(NotionFreezePlugin.prototype) as NotionFreezePlugin & Record<string, unknown>;
		const reservations = new ReservationManager();
		plugin.app = {
			workspace: { trigger: () => undefined },
		} as never;
		plugin.manifest = { id: "stonerelay", version: "0.9.8" } as never;
		plugin.settings = { ...migrateData(null), apiKey: "ntn_test", databases: [first, second] };
		(plugin as any).reservations = reservations;
		(plugin as any).syncControllers = new Map();
		(plugin as any).syncReservations = new Map();
		(plugin as any).atomicWriteEvents = [];
		(plugin as any).lastBackfilledByEntry = new Map();
		(plugin as any).cancellingAll = false;
		(plugin as any).saveSettings = async () => undefined;
		(plugin as any).findFrozenDatabase = () => null;
		(plugin as any).pullSafetyBlocker = () => null;
		const started: string[] = [];
		(plugin as any).syncConfiguredDatabase = async (entry: SyncedDatabase) => {
			started.push(entry.id);
			return result(entry.name);
		};
		const manual = await reservations.acquire({
			entryId: "manual-first",
			entryName: "Manual first",
			databaseId: first.databaseId,
			vaultFolder: first.outputFolder,
			type: "pull",
			policy: "manual",
		});

		const running = plugin.syncAllEnabledDatabases();
		await waitFor(() => started.includes("second"));
		plugin.cancelSync(first.id);
		manual.release();
		await running;

		expect(started).toEqual(["second"]);
		expect(plugin.settings.databases.find((entry) => entry.id === "first")?.lastSyncStatus).toBe("cancelled");
		expect(plugin.settings.databases.find((entry) => entry.id === "second")?.lastSyncStatus).toBe("ok");
	});

	it("manual Pull notice includes backfill counts and duplicate warnings from the production summary path", async () => {
		Notice.messages = [];
		const entry = database({ id: "manual", name: "Manual", databaseId: "33333333333343338333333333333333", outputFolder: "_relay/manual" });
		const plugin = Object.create(NotionFreezePlugin.prototype) as NotionFreezePlugin & Record<string, unknown>;
		plugin.app = {
			workspace: { trigger: () => undefined },
		} as never;
		plugin.manifest = { id: "stonerelay", version: "0.9.8" } as never;
		plugin.settings = { ...migrateData(null), apiKey: "ntn_test", databases: [entry] };
		(plugin as any).reservations = new ReservationManager();
		(plugin as any).syncControllers = new Map();
		(plugin as any).syncReservations = new Map();
		(plugin as any).atomicWriteEvents = [];
		(plugin as any).lastBackfilledByEntry = new Map();
		(plugin as any).cancellingAll = false;
		(plugin as any).saveSettings = async () => undefined;
		(plugin as any).findFrozenDatabase = () => null;
		(plugin as any).pullSafetyBlocker = () => null;
		(plugin as any).syncConfiguredDatabase = async () => ({
			...result("Manual"),
			backfilled: 2,
			warnings: ["DB has 2 local files claiming notion-id row-a: one.md, two.md. Pull updated only one.md."],
		});

		await plugin.syncOneConfiguredDatabase(entry);

		const notices = Notice.messages.join("\n");
		expect(notices).toContain("2 legacy frontmatter backfilled");
		expect(notices).toContain("Warnings:");
		expect(notices).toContain("2 local files claiming notion-id row-a");
	});
});

function database(overrides: Partial<SyncedDatabase>): SyncedDatabase {
	return {
		id: overrides.id ?? "db",
		name: overrides.name ?? "DB",
		databaseId: overrides.databaseId ?? "11111111111141118111111111111111",
		outputFolder: overrides.outputFolder ?? "_relay/db",
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
		initial_seed_direction: "pull",
		source_of_truth: null,
		first_sync_completed_at: null,
		nest_under_db_name: false,
		templater_managed: false,
		current_sync_id: null,
		lastCommittedRowId: null,
		lastSyncErrors: [],
		...overrides,
	};
}

function result(title: string) {
	return {
		title,
		folderPath: "_relay",
		total: 0,
		created: 0,
		updated: 0,
		skipped: 0,
		deleted: 0,
		failed: 0,
		errors: [],
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 20; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("Timed out waiting for condition");
}
