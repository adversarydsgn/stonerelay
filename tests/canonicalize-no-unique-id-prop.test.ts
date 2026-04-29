import { describe, expect, it, vi } from "vitest";
import { pushDatabase } from "../src/push";
import { makePushApp, makePushClient, pageResponse, withPushReservation } from "./canonicalize-test-helpers";

describe("post-create canonicalization without Notion unique_id", () => {
	it("skips notion-unique-id without error when the response has no unique_id property", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { app, files } = makePushApp([[
			"_relay/bugs/new.md",
			"---\nStatus: Doing\n---\n# New",
		]]);
		const client = makePushClient({
			createResponse: pageResponse("created-page", { uniqueId: null }),
		});

		try {
			const result = await withPushReservation((context) =>
				pushDatabase(app as never, client as never, "db-1", "_relay/bugs", { context })
			);

			expect(result.created).toBe(1);
			expect(result.failed).toBe(0);
			expect(files.get("_relay/bugs/new.md")).not.toContain("notion-unique-id:");
			expect(consoleError).not.toHaveBeenCalled();
		} finally {
			consoleError.mockRestore();
		}
	});
});
