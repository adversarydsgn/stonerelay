import { describe, expect, it } from "vitest";
import { pushDatabase } from "../src/push";
import { makePushApp, makePushClient, pageResponse, withPushReservation } from "./canonicalize-test-helpers";

describe("vault canonical ID push create", () => {
	it("writes vault ID into the configured Notion mirror property", async () => {
		const { app } = makePushApp([["_relay/bugs/new.md", "---\nID: DEC-462\nStatus: Doing\n---\n# New"]]);
		const client = makePushClient({ createResponse: pageResponse("created-page") });

		await withPushReservation((context) =>
			pushDatabase(app as never, client as never, "db-1", "_relay/bugs", {
				context,
				canonicalIdProperty: "Canonical ID",
			})
		);

		expect(client.pages.create.mock.calls[0][0].properties["Canonical ID"]).toEqual({
			rich_text: [{ type: "text", text: { content: "DEC-462" } }],
		});
	});
});
