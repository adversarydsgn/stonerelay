import { describe, expect, test } from "vitest";
import {
	DIRECTION_HELPER,
	DIRECTION_LABELS,
	EMPTY_PULL_WARNING,
	EMPTY_PUSH_WARNING,
	VaultFolderStats,
	buildConnectionPreview,
	formWarnings,
	shouldConfirmDirectionChange,
	vaultFolderHelper,
} from "../src/settings-ux";

const vaultWithFiles: VaultFolderStats = {
	path: "_relay/sessions-test",
	exists: true,
	markdownFiles: 5,
};

describe("form UX polish v0.6.3", () => {
	test("direction labels are verbose with consequence", () => {
		expect(DIRECTION_LABELS.pull).toBe("Pull (Notion is source — vault gets seeded)");
		expect(DIRECTION_LABELS.push).toBe("Push (Vault is source — Notion gets seeded)");
		expect(DIRECTION_LABELS.bidirectional).toBe("Bidirectional (both authoritative — v0.7+ only)");
		expect(DIRECTION_HELPER).toBe(
			"Bidirectional uses last-writer-wins until v0.7 ships proper conflict resolution. Use only if you understand the risk."
		);
	});

	test("vault folder helper text pivots on direction change", () => {
		expect(vaultFolderHelper("pull")).toBe(
			"Vault folder where pulled notes will be created. Existing files with same name will be overwritten."
		);
		expect(vaultFolderHelper("push")).toBe(
			"Vault folder containing markdown files to push to Notion. Files in this folder will be uploaded as Notion rows."
		);
		expect(vaultFolderHelper("bidirectional")).toBe(
			"Vault folder used for both directions. Files here will be both written-to (from Notion pulls) and read-from (for Notion pushes)."
		);
	});

	test("test connection preview shows row + file counts", async () => {
		const preview = buildConnectionPreview({
			direction: "pull",
			metadata: {
				title: "Sessions DB (Test Copy)",
				propertyCount: 23,
				rowCount: "23",
			},
			vault: vaultWithFiles,
		});

		expect(preview).toContain('✓ Connected to "Sessions DB (Test Copy)" · 23 properties · 23 rows');
		expect(preview).toContain("✓ Vault folder `_relay/sessions-test/` exists, 5 .md files");
		expect(preview).toContain("→ With Pull selected: this sync will create 23 markdown files.");
	});

	test("test connection preview updates on direction change", async () => {
		const input = {
			metadata: {
				title: "Sessions DB (Test Copy)",
				propertyCount: 23,
				rowCount: "100+",
			},
			vault: {
				path: "_relay/sessions-test",
				exists: true,
				markdownFiles: 0,
			},
		};

		expect(buildConnectionPreview({ ...input, direction: "pull" })).toContain(
			"→ With Pull selected: this sync will create 100+ markdown files."
		);
		expect(buildConnectionPreview({ ...input, direction: "push" })).toContain(
			"→ With Push selected: this sync will create 0 Notion rows (empty vault folder)."
		);
		expect(buildConnectionPreview({ ...input, direction: "bidirectional" })).toContain(
			"→ With Bidirectional selected: 100+ files created, 0 rows pushed (vault empty)."
		);
	});

	test("empty-folder warning appears on Push when vault empty", () => {
		expect(formWarnings("push", { title: "Sessions", rowCount: "23" }, {
			path: "_relay/sessions-test",
			exists: true,
			markdownFiles: 0,
		})).toEqual([EMPTY_PUSH_WARNING]);
		expect(formWarnings("push", { title: "Sessions", rowCount: "23" }, vaultWithFiles)).toEqual([]);
	});

	test("empty-Notion warning appears on Pull when DB empty", async () => {
		expect(formWarnings("pull", { title: "Sessions", rowCount: "0" }, vaultWithFiles)).toEqual([
			EMPTY_PULL_WARNING,
		]);
		expect(formWarnings("pull", { title: "Sessions", rowCount: "1" }, vaultWithFiles)).toEqual([]);
	});

	test("Edit modal confirms direction change after first sync", async () => {
		expect(shouldConfirmDirectionChange("pull", "push", "2026-04-25T12:00:00.000Z")).toBe(true);
		expect(shouldConfirmDirectionChange("pull", "pull", "2026-04-25T12:00:00.000Z")).toBe(false);
		expect(shouldConfirmDirectionChange("pull", "push", null)).toBe(false);
	});
});
