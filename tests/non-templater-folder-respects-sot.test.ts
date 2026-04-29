import { describe, expect, it } from "vitest";
import { decideBidirectionalAction } from "../src/conflict-resolution";

const baseInput = {
	rowId: "row-1",
	notionChanged: true,
	vaultChanged: true,
	notionEditedAt: "2026-04-29T10:02:00.000Z",
	vaultEditedAt: "2026-04-29T10:03:00.000Z",
	notionSnapshot: { Status: "Notion" },
	vaultSnapshot: { Status: "Vault" },
	detectedAt: "2026-04-29T10:04:00.000Z",
};

describe("non-templater conflict behavior", () => {
	it("keeps notion source_of_truth behavior unchanged", () => {
		expect(decideBidirectionalAction({
			...baseInput,
			sourceOfTruth: "notion",
			templaterManaged: false,
		}).action).toBe("pull");
		expect(decideBidirectionalAction({
			...baseInput,
			sourceOfTruth: "notion",
		}).action).toBe("pull");
	});
});
