import { describe, expect, it } from "vitest";
import { pushDatabase } from "../src/push";
import { makePushApp, makePushClient, pageResponse, withPushReservation } from "./canonicalize-test-helpers";

describe("vault canonical ID disabled mode", () => {
	it("ignores vault ID when canonical_id_property is null", async () => {
		const { app } = makePushApp([["_relay/bugs/new.md", "---\nID: DEC-462\nStatus: Doing\n---\n# New"]]);
		const client = makePushClient({ createResponse: pageResponse("created-page") });

		await withPushReservation((context) =>
			pushDatabase(app as never, client as never, "db-1", "_relay/bugs", {
				context,
				canonicalIdProperty: null,
			})
		);

		expect(client.pages.create.mock.calls[0][0].properties["Canonical ID"]).toBeUndefined();
	});
});
