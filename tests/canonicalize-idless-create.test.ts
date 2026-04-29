import { describe, expect, it } from "vitest";
import { pushDatabase } from "../src/push";
import { makePushApp, makePushClient, pageResponse, withPushReservation } from "./canonicalize-test-helpers";

describe("post-create canonicalization", () => {
	for (const [name, rename] of [["capability-A rename", true], ["capability-B fallback", false]] as const) {
		it(`writes all canonical fields after push-create under ${name}`, async () => {
			const { app, files } = makePushApp([[
				"_relay/bugs/new.md",
				"---\nStatus: Doing\n---\n# New",
			]], { rename });
			const client = makePushClient({
				createResponse: pageResponse("created-page", { uniqueId: "ADV-462" }),
			});

			const result = await withPushReservation((context) =>
				pushDatabase(app as never, client as never, "db-1", "_relay/bugs", { context })
			);

			expect(result.created).toBe(1);
			const committed = files.get("_relay/bugs/new.md") ?? "";
			expect(committed).toContain("notion-id: created-page");
			expect(committed).toContain('notion-url: "https://www.notion.so/created-page"');
			expect(committed).toContain('notion-last-edited: "2026-04-29T01:23:45.678Z"');
			expect(committed).toContain("notion-database-id: db-1");
			expect(committed).toContain("notion-unique-id: ADV-462");
		});
	}
});
