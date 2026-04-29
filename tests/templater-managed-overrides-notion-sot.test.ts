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

describe("templater-managed conflict override", () => {
	it("returns conflict when source_of_truth is notion", () => {
		const result = decideBidirectionalAction({
			...baseInput,
			sourceOfTruth: "notion",
			templaterManaged: true,
		});

		expect(result.action).toBe("conflict");
	});
});
