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

describe("templater conflict shape parity", () => {
	it("matches manual_merge conflict snapshots", () => {
		const templaterConflict = decideBidirectionalAction({
			...baseInput,
			sourceOfTruth: "notion",
			templaterManaged: true,
		}).conflict;
		const manualMergeConflict = decideBidirectionalAction({
			...baseInput,
			sourceOfTruth: "manual_merge",
			templaterManaged: false,
		}).conflict;

		expect(templaterConflict).toEqual(manualMergeConflict);
		expect(Object.keys(templaterConflict ?? {}).sort()).toEqual([
			"detectedAt",
			"notionEditedAt",
			"notionSnapshot",
			"rowId",
			"vaultEditedAt",
			"vaultSnapshot",
		]);
	});
});
