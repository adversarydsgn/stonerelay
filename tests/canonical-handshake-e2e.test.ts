import { describe, expect, it } from "vitest";
import { refreshDatabase } from "../src/database-freezer";
import { pushDatabase } from "../src/push";
import { makePushApp, makePushClient, pageResponse, withPushReservation } from "./canonicalize-test-helpers";
import { page, pullApp, pullClient, withPullReservation } from "./vault-canonical-test-helpers";

describe("vault canonical handshake", () => {
	it("pushes vault ID to mirror and pulls mirror ID into a Notion-only row", async () => {
		const pushApp = makePushApp([["_relay/bugs/new.md", "---\nID: DEC-462\nStatus: Doing\n---\n# New"]]);
		const pushClient = makePushClient({ createResponse: pageResponse("created-page", { uniqueId: "ADV-462" }) });
		await withPushReservation((context) =>
			pushDatabase(pushApp.app as never, pushClient as never, "db-1", "_relay/bugs", {
				context,
				canonicalIdProperty: "Canonical ID",
			})
		);
		expect(pushClient.pages.create.mock.calls[0][0].properties["Canonical ID"].rich_text[0].text.content).toBe("DEC-462");

		const app = pullApp([], [["_relay/A/.next-id", "463\n"]]);
		const client = pullClient([page("row-a", "New", { mirror: "DEC-462", uniqueNumber: 462 })]);
		await withPullReservation((context) => refreshDatabase(app as never, client as never, {
			databaseId: "db-a",
			title: "A",
			folderPath: "_relay/A",
			entryCount: 0,
		}, undefined, undefined, { context, canonicalIdProperty: "Canonical ID" }));

		const pulled = [...app.vault.adapter.files.entries()].find(([path]) => path.endsWith(".md"))?.[1] ?? "";
		expect(pulled).toContain("ID: DEC-462");
		expect(pulled).toContain("notion-unique-id: DEC-462");
	});
});
