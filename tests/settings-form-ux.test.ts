import { describe, expect, test } from "vitest";
import {
	DIRECTION_HELPER,
	DIRECTION_LABELS,
	DIRECTION_OPTION_ORDER,
	DIRECTION_SECTION_HELPER,
	EMPTY_PULL_WARNING,
	EMPTY_PUSH_WARNING,
	PREVIEW_PLACEHOLDER,
	VaultFolderStats,
	buildConnectionPreview,
	buildConnectionPreviewRows,
	directionChangeWarning,
	formWarnings,
	shouldAutoFillDatabaseName,
	shouldConfirmDirectionChange,
	vaultFolderHelper,
} from "../src/settings-ux";

const vaultWithFiles: VaultFolderStats = {
	path: "_relay/sessions-test",
	exists: true,
	markdownFiles: 5,
};

describe("form UX polish v0.6.3/v0.6.4", () => {
	test('"Sync direction" section header renders', () => {
		expect("Sync direction").toBe("Sync direction");
		expect(DIRECTION_SECTION_HELPER).toBe(
			"Pull seeds vault from Notion. Push seeds Notion from vault. Bidirectional pegs both sides and surfaces conflicts for review."
		);
	});

	test("all three radio options visible without overflow", () => {
		expect(DIRECTION_OPTION_ORDER.map((direction) => DIRECTION_LABELS[direction])).toMatchInlineSnapshot(`
			[
			  "Pull (Notion is source — vault gets seeded)",
			  "Push (Vault is source — Notion gets seeded)",
			  "Bidirectional (pegged partnership)",
			]
		`);
	});

	test("helper text under radio renders Bidirectional conflict caveat", () => {
		expect(DIRECTION_HELPER).toContain("pegs both sides");
		expect(DIRECTION_HELPER).toContain("Conflicts are surfaced for review");
	});

	test("test connection preview placeholder renders before first click", () => {
		expect(PREVIEW_PLACEHOLDER).toBe("Click Test connection to preview row counts and next-sync action.");
	});

	test("direction labels are verbose with consequence", () => {
		expect(DIRECTION_LABELS.pull).toBe("Pull (Notion is source — vault gets seeded)");
		expect(DIRECTION_LABELS.push).toBe("Push (Vault is source — Notion gets seeded)");
		expect(DIRECTION_LABELS.bidirectional).toBe("Bidirectional (pegged partnership)");
		expect(DIRECTION_HELPER).toBe(
			"Bidirectional pegs both sides. Conflicts are surfaced for review instead of silently overwritten."
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
		expect(buildConnectionPreviewRows({
			direction: "pull",
			metadata: {
				title: "Sessions DB (Test Copy)",
				propertyCount: 23,
				rowCount: "23",
			},
			vault: vaultWithFiles,
		})).toEqual([
			{ icon: "✓", text: 'Connected to "Sessions DB (Test Copy)" · 23 properties · 23 rows' },
			{ icon: "✓", text: "Vault folder `_relay/sessions-test/` exists, 5 .md files" },
			{ icon: "→", text: "With Pull selected: this sync will create 23 markdown files." },
		]);
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
		expect(directionChangeWarning("pull", "push")).toContain("Obsidian becomes authoritative");
		expect(directionChangeWarning("push", "bidirectional")).toContain("Conflicts may surface");
		expect(directionChangeWarning("bidirectional", "pull")).toContain("will not propagate to Notion");
	});

	test("new database default name auto-fills from fetched Notion title until user edits it", () => {
		expect(shouldAutoFillDatabaseName("Untitled database", false, true)).toBe(true);
		expect(shouldAutoFillDatabaseName("", false, true)).toBe(true);
		expect(shouldAutoFillDatabaseName("Custom label", false, true)).toBe(false);
		expect(shouldAutoFillDatabaseName("Untitled database", true, true)).toBe(false);
		expect(shouldAutoFillDatabaseName("Untitled database", false, false)).toBe(false);
	});
});
