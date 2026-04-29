import { describe, expect, it } from "vitest";
import { pushDatabase } from "../src/push";
import { makePushApp, makePushClient, pageResponse, withPushReservation } from "./canonicalize-test-helpers";

describe("push intent canonicalized phase", () => {
	it("records creating, created, canonicalized, then committed for a completed create", async () => {
		const { app } = makePushApp([[
			"_relay/bugs/new.md",
			"---\nStatus: Doing\n---\n# New",
		]]);
		const client = makePushClient({
			createResponse: pageResponse("created-page", { uniqueId: "ADV-462" }),
		});
		const phases: string[] = [];

		await withPushReservation((context) =>
			pushDatabase(app as never, client as never, "db-1", "_relay/bugs", {
				context,
				onPushIntentCreating: async () => {
					phases.push("creating");
					return "intent-1";
				},
				onPushIntentCreated: async (_intentId, notionId) => {
					phases.push(`created:${notionId}`);
				},
				onPushIntentCanonicalized: async (_intentId, fieldsWritten) => {
					phases.push(`canonicalized:${fieldsWritten.join(",")}`);
				},
				onPushIntentCommitted: async () => {
					phases.push("committed");
				},
			})
		);

		expect(phases).toEqual([
			"creating",
			"created:created-page",
			"canonicalized:notion-id,notion-url,notion-last-edited,notion-database-id,notion-unique-id",
			"committed",
		]);
	});
});
