import { describe, expect, it } from "vitest";
import { pushDatabase } from "../src/push";
import { existingPage, makePushApp, makePushClient, pageResponse, withPushReservation } from "./canonicalize-test-helpers";

describe("vault canonical ID push update", () => {
	it("writes vault ID into the mirror property on update", async () => {
		const { app } = makePushApp([["_relay/bugs/existing.md", "---\nnotion-id: page-1\nID: DEC-463\nStatus: Doing\n---\n# Existing"]]);
		const client = makePushClient({
			existingPages: [existingPage("page-1", "Existing")],
			updateResponse: pageResponse("page-1"),
		});

		await withPushReservation((context) =>
			pushDatabase(app as never, client as never, "db-1", "_relay/bugs", {
				context,
				canonicalIdProperty: "Canonical ID",
			})
		);

		expect(client.pages.update.mock.calls[0][0].properties["Canonical ID"]).toEqual({
			rich_text: [{ type: "text", text: { content: "DEC-463" } }],
		});
	});
});
