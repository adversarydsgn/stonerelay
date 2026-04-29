import { describe, expect, it } from "vitest";
import { refreshDatabase } from "../src/database-freezer";
import { page, pullApp, pullClient, withPullReservation } from "./vault-canonical-test-helpers";

describe("pull feature-off behavior", () => {
	it("keeps v0.9.11 unique_id materialization when canonical_id_property is null", async () => {
		const app = pullApp([]);
		const client = pullClient([page("row-a", "New", { uniqueNumber: 461 })]);

		await withPullReservation((context) => refreshDatabase(app as never, client as never, {
			databaseId: "db-a",
			title: "A",
			folderPath: "_relay/A",
			entryCount: 0,
		}, undefined, undefined, { context, canonicalIdProperty: null }));

		const content = [...app.vault.adapter.files.entries()].find(([path]) => path.endsWith(".md"))?.[1] ?? "";
		expect(content).toContain("ID: DEC-461");
		expect(content).not.toContain("notion-unique-id:");
	});
});
