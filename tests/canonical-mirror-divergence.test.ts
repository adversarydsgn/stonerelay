import { describe, expect, it, vi } from "vitest";
import { pushDatabase } from "../src/push";
import { makePushApp, makePushClient, pageResponse, richText, withPushReservation } from "./canonicalize-test-helpers";

describe("vault canonical mirror divergence", () => {
	it("surfaces a conflict and still defaults to vault-wins mirror update", async () => {
		const { app } = makePushApp([[
			"_relay/bugs/existing.md",
			"---\nnotion-id: page-1\nnotion-last-edited: \"2026-04-28T00:00:00.000Z\"\nID: DEC-463\nStatus: Doing\n---\n# Existing",
		]]);
		const onConflict = vi.fn();
		const client = makePushClient({
			existingPages: [{
				object: "page",
				id: "page-1",
				last_edited_time: "2026-04-29T00:00:00.000Z",
				properties: {
					Name: { type: "title", title: [richText("Existing")] },
					"Canonical ID": { type: "rich_text", rich_text: [richText("DEC-999")] },
				},
			}],
			updateResponse: pageResponse("page-1"),
		});

		await withPushReservation((context) =>
			pushDatabase(app as never, client as never, "db-1", "_relay/bugs", {
				context,
				canonicalIdProperty: "Canonical ID",
				bidirectional: {
					sourceOfTruth: "notion",
					lastSyncedAt: null,
					onConflict,
				},
			})
		);

		expect(onConflict).toHaveBeenCalledTimes(1);
		expect(onConflict.mock.calls[0][0].notionSnapshot).toMatchObject({ canonicalId: "DEC-999" });
		expect(client.pages.update.mock.calls[0][0].properties["Canonical ID"].rich_text[0].text.content).toBe("DEC-463");
	});
});
