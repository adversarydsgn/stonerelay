import { describe, expect, it } from "vitest";
import { pushDatabase } from "../src/push";
import { existingPage, makePushApp, makePushClient, pageResponse, withPushReservation } from "./canonicalize-test-helpers";

describe("push-update canonicalization", () => {
	for (const [name, rename] of [["capability-A rename", true], ["capability-B fallback", false]] as const) {
		it(`refreshes canonical fields from the update response under ${name}`, async () => {
			const { app, files } = makePushApp([[
				"_relay/bugs/existing.md",
				"---\nnotion-id: page-1\nnotion-url: old\nnotion-last-edited: old\nnotion-database-id: old-db\nnotion-unique-id: OLD-1\nStatus: Doing\n---\n# Existing",
			]], { rename });
			const client = makePushClient({
				existingPages: [existingPage("page-1", "Existing")],
				updateResponse: pageResponse("page-1", {
					uniqueId: "ADV-463",
					url: "https://www.notion.so/page-1-updated",
					lastEdited: "2026-04-29T02:00:00.000Z",
				}),
			});

			const result = await withPushReservation((context) =>
				pushDatabase(app as never, client as never, "db-1", "_relay/bugs", { context })
			);

			expect(result.updated).toBe(1);
			const committed = files.get("_relay/bugs/existing.md") ?? "";
			expect(committed).toContain("notion-id: page-1");
			expect(committed).toContain('notion-url: "https://www.notion.so/page-1-updated"');
			expect(committed).toContain('notion-last-edited: "2026-04-29T02:00:00.000Z"');
			expect(committed).toContain("notion-database-id: db-1");
			expect(committed).toContain("notion-unique-id: ADV-463");
		});
	}
});
