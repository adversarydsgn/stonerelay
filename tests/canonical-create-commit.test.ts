import { describe, expect, it, vi } from "vitest";
import { pushDatabase } from "../src/push";
import { makePushApp, makePushClient, pageResponse, withPushReservation } from "./canonicalize-test-helpers";

describe("vault canonical ID create commit", () => {
	it("commits Notion canonical fields atomically without changing vault ID", async () => {
		const { app, files } = makePushApp([["_relay/bugs/new.md", "---\nID: DEC-462\nStatus: Doing\n---\n# New"]]);
		const client = makePushClient({ createResponse: pageResponse("created-page", { uniqueId: "ADV-462" }) });
		const committed = vi.fn();

		await withPushReservation((context) =>
			pushDatabase(app as never, client as never, "db-1", "_relay/bugs", {
				context,
				canonicalIdProperty: "Canonical ID",
				onAtomicWriteCommitted: committed,
			})
		);

		const content = files.get("_relay/bugs/new.md") ?? "";
		expect(committed).toHaveBeenCalledTimes(1);
		expect(content).toContain("ID: DEC-462");
		expect(content).toContain("notion-id: created-page");
		expect(content).toContain("notion-database-id: db-1");
		expect(content).toContain("notion-unique-id: ADV-462");
	});
});
