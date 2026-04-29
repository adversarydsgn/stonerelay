import { describe, expect, it, vi } from "vitest";
import * as notionClientObsidianModule from "../src/notion-client-obsidian";
import { appendIntentRecord, recoverPushIntents } from "../src/push-intents";
import { makePushClient, makeRecoveryPlugin, memoryAdapter, pageResponse } from "./canonicalize-test-helpers";

describe("push-intent recovery before canonicalized", () => {
	for (const [name, rename] of [["capability-A rename", true], ["capability-B fallback", false]] as const) {
		it(`re-fetches and applies all canonical fields under ${name}`, async () => {
			const filePath = "3. System/Bugs DB/new.md";
			const adapter = memoryAdapter([[filePath, "---\nStatus: Doing\n---\n# New"]], rename);
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
				phase: "created",
				notion_id: "page-new",
				completed_at: "2026-04-28T10:00:01.000Z",
			});
			const recoveries = await recoverPushIntents(adapter, ".obsidian/plugins/stonerelay/push-intents.jsonl", new Date("2026-04-29T00:00:00.000Z"));
			const client = makePushClient({
				retrieveResponse: pageResponse("page-new", { uniqueId: "ADV-462" }),
			});
			const createClient = vi.spyOn(notionClientObsidianModule, "createObsidianNotionClient").mockReturnValue(client as never);
			const { plugin } = makeRecoveryPlugin(adapter, filePath, recoveries, { folderPath: "3. System/Bugs DB" });

			try {
				expect(recoveries).toHaveLength(1);
				expect(recoveries[0]).toMatchObject({ intentId: "intent-1", phase: "created" });

				await plugin.applyPushIntentRecovery("intent-1");

				const committed = adapter.files.get(filePath) ?? "";
				expect(committed).toContain("notion-id: page-new");
				expect(committed).toContain('notion-url: "https://www.notion.so/page-new"');
				expect(committed).toContain('notion-last-edited: "2026-04-29T01:23:45.678Z"');
				expect(committed).toContain("notion-database-id: db-1");
				expect(committed).toContain("notion-unique-id: ADV-462");
				const log = adapter.files.get(".obsidian/plugins/stonerelay/push-intents.jsonl") ?? "";
				expect(log).toContain('"phase":"canonicalized"');
				expect(log).toContain('"phase":"committed"');
				expect(plugin.getPushIntentRecoveries()).toEqual([]);
			} finally {
				createClient.mockRestore();
			}
		});
	}
});
