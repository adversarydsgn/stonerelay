import { describe, expect, it } from "vitest";
import { refreshDatabase } from "../src/database-freezer";
import { page, pullApp, pullClient, withPullReservation } from "./vault-canonical-test-helpers";

describe("pull sequence lag warning", () => {
	it("warns when observed Notion unique_id max is at or beyond .next-id", async () => {
		const app = pullApp([], [["_relay/A/.next-id", "462\n"]]);
		const client = pullClient([page("row-a", "New", { mirror: null, uniqueNumber: 462 })]);

		const result = await withPullReservation((context) => refreshDatabase(app as never, client as never, {
			databaseId: "db-a",
			title: "A",
			folderPath: "_relay/A",
			entryCount: 0,
		}, undefined, undefined, { context, canonicalIdProperty: "Canonical ID" }));

		expect(result.sequenceLag).toBe(true);
		expect(result.observedUniqueIdMax).toBe(462);
		expect(result.warnings?.join("\n")).toContain("may be behind");
	});
});
