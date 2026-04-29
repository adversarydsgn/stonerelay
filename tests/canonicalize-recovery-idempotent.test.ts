import { describe, expect, it, vi } from "vitest";
import * as notionClientObsidianModule from "../src/notion-client-obsidian";
import { appendIntentRecord, recoverPushIntents } from "../src/push-intents";
import { makePushClient, makeRecoveryPlugin, memoryAdapter, pageResponse } from "./canonicalize-test-helpers";

describe("push-intent recovery idempotency", () => {
	it("does not duplicate writes or committed records when recovery is run twice", async () => {
		const filePath = "3. System/Bugs DB/new.md";
		const adapter = memoryAdapter([[
			filePath,
			"---\nnotion-id: page-new\nnotion-url: \"https://www.notion.so/page-new\"\nnotion-last-edited: \"2026-04-29T01:23:45.678Z\"\nnotion-database-id: db-1\nnotion-unique-id: ADV-462\nStatus: Doing\n---\n# New",
		]]);
		await appendIntentRecord(adapter, ".obsidian/plugins/stonerelay/push-intents.jsonl", {
			intent_id: "intent-1",
			reservation_id: "reservation-1",
			vault_path: filePath,
			title_hash: "abc",
			phase: "creating",
			started_at: "2026-04-28T10:00:00.000Z",
		});
		await appendIntentRecord(adapter, ".obsidian/plugins/stonerelay/push-intents.jsonl", {
			intent_id: "intent-1",
			reservation_id: "reservation-1",
			vault_path: "",
			title_hash: "",
			phase: "canonicalized",
			notion_id: "page-new",
			fields_written: [],
			completed_at: "2026-04-28T10:00:02.000Z",
		});
		const recoveries = await recoverPushIntents(adapter, ".obsidian/plugins/stonerelay/push-intents.jsonl", new Date("2026-04-29T00:00:00.000Z"));
		const client = makePushClient({
			retrieveResponse: pageResponse("page-new", { uniqueId: "ADV-462" }),
		});
		const createClient = vi.spyOn(notionClientObsidianModule, "createObsidianNotionClient").mockReturnValue(client as never);
		const { plugin } = makeRecoveryPlugin(adapter, filePath, recoveries, { folderPath: "3. System/Bugs DB" });

		try {
			await plugin.applyPushIntentRecovery("intent-1");
			await plugin.applyPushIntentRecovery("intent-1");

			const log = adapter.files.get(".obsidian/plugins/stonerelay/push-intents.jsonl") ?? "";
			expect((log.match(/"phase":"committed"/g) ?? [])).toHaveLength(1);
			expect(plugin.getAtomicWriteEvents()).toEqual([]);
			expect(plugin.getPushIntentRecoveries()).toEqual([]);
		} finally {
			createClient.mockRestore();
		}
	});
});
