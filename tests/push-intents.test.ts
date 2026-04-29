import { describe, expect, it, vi } from "vitest";
import { appendIntentRecord, recoverPushIntents } from "../src/push-intents";

describe("push intent log", () => {
	it("surfaces created-but-uncommitted intents for startup recovery", async () => {
		const adapter = memoryAdapter();
		await appendIntentRecord(adapter, "push-intents.jsonl", {
			intent_id: "intent-1",
			reservation_id: "reservation-1",
			vault_path: "_relay/Bugs DB/New.md",
			title_hash: "abc",
			phase: "creating",
			started_at: "2026-04-27T10:00:00.000Z",
		});
		await appendIntentRecord(adapter, "push-intents.jsonl", {
			intent_id: "intent-1",
			reservation_id: "reservation-1",
			vault_path: "",
			title_hash: "",
			phase: "created",
			notion_id: "page-1",
			completed_at: "2026-04-27T10:00:01.000Z",
		});

		expect(await recoverPushIntents(adapter, "push-intents.jsonl", new Date("2026-04-28T00:00:00.000Z"))).toEqual([{
				intentId: "intent-1",
				vaultPath: "_relay/Bugs DB/New.md",
				notionId: "page-1",
				phase: "created",
				message: "Push for _relay/Bugs DB/New.md created Notion page page-1 but did not write canonical fields locally. Apply them now? Or delete the orphan Notion page?",
			}]);
		});

	it("persists records atomically without torn lines when temp write fails", async () => {
		const adapter = memoryAdapter();
		await appendIntentRecord(adapter, "push-intents.jsonl", baseRecord("intent-1"));
		adapter.write = vi.fn(async (path: string, data: string) => {
			if (path.includes(".tmp-")) throw new Error("disk full");
			adapter.files.set(path, data);
		});

		await expect(appendIntentRecord(adapter, "push-intents.jsonl", baseRecord("intent-2"))).rejects.toThrow("disk full");
		const lines = adapter.files.get("push-intents.jsonl")?.trim().split(/\r?\n/) ?? [];
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]).intent_id).toBe("intent-1");
	});

	it("does not overwrite the live log when rename replacement is degraded", async () => {
		const adapter = memoryAdapter();
		await appendIntentRecord(adapter, "push-intents.jsonl", baseRecord("intent-1"));
		adapter.rename = vi.fn(async () => {
			throw new Error("rename replacement unavailable");
		});
		adapter.write = vi.fn(async (path: string, data: string) => {
			if (!path.includes(".tmp-")) throw new Error("final write should not run");
			adapter.files.set(path, data);
		});

		await expect(appendIntentRecord(adapter, "push-intents.jsonl", baseRecord("intent-2")))
			.rejects.toThrow("Atomic");
		const lines = adapter.files.get("push-intents.jsonl")?.trim().split(/\r?\n/) ?? [];
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]).intent_id).toBe("intent-1");
		expect(adapter.write).not.toHaveBeenCalledWith("push-intents.jsonl", expect.any(String));
	});
});

function baseRecord(intentId: string) {
	return {
		intent_id: intentId,
		reservation_id: "reservation-1",
		vault_path: "_relay/Bugs DB/New.md",
		title_hash: "abc",
		phase: "creating" as const,
		started_at: "2026-04-27T10:00:00.000Z",
	};
}

function memoryAdapter() {
	const adapter = {
		files: new Map<string, string>(),
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
