import { describe, expect, it } from "vitest";
import { refreshDatabase } from "../src/database-freezer";
import { page, pullApp, pullClient, withPullReservation } from "./vault-canonical-test-helpers";

describe("pull Notion-only mirror adoption", () => {
	it("adopts populated mirror ID without advancing .next-id", async () => {
		const app = pullApp([], [["_relay/A/.next-id", "462\n"]]);
		const client = pullClient([page("row-a", "New", { mirror: "DEC-460", uniqueNumber: 461 })]);

		const result = await withPullReservation((context) => refreshDatabase(app as never, client as never, {
			databaseId: "db-a",
			title: "A",
			folderPath: "_relay/A",
			entryCount: 0,
		}, undefined, undefined, { context, canonicalIdProperty: "Canonical ID" }));

		const content = [...app.vault.adapter.files.entries()].find(([path]) => path.endsWith(".md"))?.[1] ?? "";
		expect(content).toContain("ID: DEC-460");
		expect(app.vault.adapter.files.get("_relay/A/.next-id")).toBe("462\n");
		expect(result.adoptedMirrorIds).toBe(1);
	});
});
