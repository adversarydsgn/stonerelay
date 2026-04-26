import { describe, expect, test } from "vitest";
import {
	decideBidirectionalAction,
	resolveManualMergeConflict,
} from "../src/conflict-resolution";

const base = {
	rowId: "row-1",
	notionEditedAt: "2026-04-24T15:30:00.000Z",
	vaultEditedAt: "2026-04-24T16:45:00.000Z",
	notionSnapshot: { Status: "Notion" },
	vaultSnapshot: { Status: "Vault" },
	detectedAt: "2026-04-25T21:00:00.000Z",
};

describe("Phase 2 conflict resolution", () => {
	test("Case 1 - neither changed skips", () => {
		expect(decideBidirectionalAction({
			...base,
			notionChanged: false,
			vaultChanged: false,
			sourceOfTruth: "notion",
		}).action).toBe("skip");
	});

	test("Case 2 - only Notion changed pulls", () => {
		expect(decideBidirectionalAction({
			...base,
			notionChanged: true,
			vaultChanged: false,
			sourceOfTruth: "notion",
		}).action).toBe("pull");
	});

	test("Case 3 - only vault changed pushes", () => {
		expect(decideBidirectionalAction({
			...base,
			notionChanged: false,
			vaultChanged: true,
			sourceOfTruth: "notion",
		}).action).toBe("push");
	});

	test("Case 4a - both changed, source_of_truth=notion pulls with warning", () => {
		const result = decideBidirectionalAction({
			...base,
			notionChanged: true,
			vaultChanged: true,
			sourceOfTruth: "notion",
		});
		expect(result.action).toBe("pull");
		expect(result.warning).toContain("Notion wins");
	});

	test("Case 4b - both changed, source_of_truth=obsidian pushes with warning", () => {
		const result = decideBidirectionalAction({
			...base,
			notionChanged: true,
			vaultChanged: true,
			sourceOfTruth: "obsidian",
		});
		expect(result.action).toBe("push");
		expect(result.warning).toContain("vault wins");
	});

	test("Case 4c - both changed, source_of_truth=manual_merge stashes conflict", () => {
		const result = decideBidirectionalAction({
			...base,
			notionChanged: true,
			vaultChanged: true,
			sourceOfTruth: "manual_merge",
		});
		expect(result.action).toBe("conflict");
		expect(result.conflict).toMatchObject({
			rowId: "row-1",
			notionSnapshot: { Status: "Notion" },
			vaultSnapshot: { Status: "Vault" },
		});
	});

	test("manual_merge resolution: keep Notion clears conflict and applies pull", () => {
		const conflict = decideBidirectionalAction({
			...base,
			notionChanged: true,
			vaultChanged: true,
			sourceOfTruth: "manual_merge",
		}).conflict!;

		const result = resolveManualMergeConflict([conflict], "row-1", "keep_notion");
		expect(result.action).toBe("pull");
		expect(result.conflicts).toEqual([]);
	});

	test("manual_merge resolution: keep vault clears conflict and applies push", () => {
		const conflict = decideBidirectionalAction({
			...base,
			notionChanged: true,
			vaultChanged: true,
			sourceOfTruth: "manual_merge",
		}).conflict!;

		const result = resolveManualMergeConflict([conflict], "row-1", "keep_vault");
		expect(result.action).toBe("push");
		expect(result.conflicts).toEqual([]);
	});

	test("manual_merge resolution: skip leaves conflict pending", () => {
		const conflict = decideBidirectionalAction({
			...base,
			notionChanged: true,
			vaultChanged: true,
			sourceOfTruth: "manual_merge",
		}).conflict!;

		const result = resolveManualMergeConflict([conflict], "row-1", "skip");
		expect(result.action).toBe("skip");
		expect(result.conflicts).toEqual([conflict]);
	});

	test("conflict snapshots are stored at detection time", () => {
		const notionSnapshot = { Status: "Notion" };
		const result = decideBidirectionalAction({
			...base,
			notionChanged: true,
			vaultChanged: true,
			sourceOfTruth: "manual_merge",
			notionSnapshot,
		});
		notionSnapshot.Status = "Changed after detection";
		expect(result.conflict?.notionSnapshot).toEqual({ Status: "Notion" });
	});
});

