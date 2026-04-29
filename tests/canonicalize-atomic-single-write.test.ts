import { describe, expect, it, vi } from "vitest";
import { pushDatabase } from "../src/push";
import { makePushApp, makePushClient, pageResponse, withPushReservation } from "./canonicalize-test-helpers";

describe("post-create canonicalization atomic write", () => {
	it("commits all canonical fields through one atomic write callback per row", async () => {
		const { app } = makePushApp([[
			"_relay/bugs/new.md",
			"---\nStatus: Doing\n---\n# New",
		]]);
		const client = makePushClient({
			createResponse: pageResponse("created-page", { uniqueId: "ADV-462" }),
		});
		const committed = vi.fn();

		await withPushReservation((context) =>
			pushDatabase(app as never, client as never, "db-1", "_relay/bugs", {
				context,
				onAtomicWriteCommitted: committed,
			})
		);

		expect(committed).toHaveBeenCalledTimes(1);
		expect(committed).toHaveBeenCalledWith("_relay/bugs/new.md");
	});
});
