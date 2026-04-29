import { describe, expect, it } from "vitest";
import { refreshDatabase } from "../src/database-freezer";
import { page, pullApp, pullClient, withPullReservation } from "./vault-canonical-test-helpers";

describe("pull Notion-only vault canonical defer", () => {
	it("creates a file without ID when mirror is empty and reports awaiting stamp", async () => {
		const app = pullApp([], [["_relay/A/.next-id", "462\n"]]);
		const client = pullClient([page("row-a", "New", { mirror: null, uniqueNumber: 461 })]);

		const result = await withPullReservation((context) => refreshDatabase(app as never, client as never, {
			databaseId: "db-a",
			title: "A",
			folderPath: "_relay/A",
			entryCount: 0,
		}, undefined, undefined, { context, canonicalIdProperty: "Canonical ID" }));

		const content = [...app.vault.adapter.files.entries()].find(([path]) => path.endsWith(".md"))?.[1] ?? "";
		expect(content).not.toContain("\nID:");
		expect(content).toContain("notion-unique-id: DEC-461");
		expect(result.awaitingIdStamp).toBe(1);
		expect(result.warnings?.join("\n")).toContain("awaiting ID stamp");
	});
});
