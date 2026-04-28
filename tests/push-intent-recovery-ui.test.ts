import { describe, expect, it } from "vitest";
import { TFile, TFolder } from "obsidian";
import NotionFreezePlugin from "../src/main";
import { appendIntentRecord } from "../src/push-intents";
import { ReservationManager } from "../src/reservations";
import { migrateData } from "../src/settings-data";

describe("push intent recovery actions", () => {
	it("applies a recovered Notion id through reservation and atomic vault write", async () => {
		const adapter = memoryAdapter([[
			"3. System/Bugs DB/new.md",
			"---\nStatus: Doing\n---\n# New",
		]]);
		await appendIntentRecord(adapter, ".obsidian/plugins/stonerelay/push-intents.jsonl", {
			intent_id: "intent-1",
			reservation_id: "reservation-1",
			vault_path: "3. System/Bugs DB/new.md",
			title_hash: "abc",
			phase: "creating",
			started_at: "2026-04-28T10:00:00.000Z",
		});
		await appendIntentRecord(adapter, ".obsidian/plugins/stonerelay/push-intents.jsonl", {
			intent_id: "intent-1",
			reservation_id: "reservation-1",
			vault_path: "",
			title_hash: "",
			phase: "created",
			notion_id: "page-new",
			completed_at: "2026-04-28T10:00:01.000Z",
		});
		const folder = Object.assign(Object.create(TFolder.prototype), { path: "3. System/Bugs DB" });
		const file = Object.assign(Object.create(TFile.prototype), {
			path: "3. System/Bugs DB/new.md",
			name: "new.md",
			basename: "new",
			extension: "md",
			parent: folder,
			stat: { mtime: 1 },
		});
		const plugin = Object.create(NotionFreezePlugin.prototype) as NotionFreezePlugin & Record<string, unknown>;
		plugin.app = {
			vault: {
				adapter,
				getAbstractFileByPath: (path: string) => path === file.path ? file : null,
				cachedRead: async (target: TFile) => adapter.files.get(target.path) ?? "",
			},
			workspace: { trigger: () => undefined },
		} as never;
		plugin.manifest = { id: "stonerelay", version: "0.9.8" } as never;
		plugin.settings = migrateData(null);
		(plugin as any).reservations = new ReservationManager();
		(plugin as any).pushIntentRecoveries = [{
			intentId: "intent-1",
			vaultPath: file.path,
			notionId: "page-new",
			message: "Push recovery needs action",
		}];
		(plugin as any).atomicWriteEvents = [];

		await plugin.applyPushIntentRecovery("intent-1");

		expect(adapter.files.get(file.path)).toContain("notion-id: page-new");
		expect(adapter.files.get(".obsidian/plugins/stonerelay/push-intents.jsonl")).toContain('"phase":"committed"');
		expect(plugin.getPushIntentRecoveries()).toEqual([]);
		expect(plugin.getAtomicWriteEvents()[0]).toMatchObject({ path: file.path });
		expect(plugin.getActiveOperationSnapshots()).toEqual([]);
	});
});

function memoryAdapter(initial: Array<[string, string]> = []) {
	const adapter = {
		files: new Map<string, string>(initial),
		async write(path: string, data: string) {
			adapter.files.set(path, data);
		},
		async read(path: string) {
			return adapter.files.get(path) ?? "";
		},
		async rename(from: string, to: string) {
			const data = adapter.files.get(from);
			if (data === undefined) throw new Error("missing temp");
			adapter.files.set(to, data);
			adapter.files.delete(from);
		},
		async remove(path: string) {
			adapter.files.delete(path);
		},
	};
	return adapter;
}
