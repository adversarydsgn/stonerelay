import { describe, expect, it } from "vitest";
import { frontmatterValueToNotionPayload } from "../src/push";

describe("Notion unique_id skip invariant", () => {
	it("does not build a writable Notion payload for unique_id", () => {
		expect(frontmatterValueToNotionPayload("unique_id", "ID", "DEC-462")).toBeUndefined();
	});
});
