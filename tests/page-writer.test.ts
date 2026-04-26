import { describe, expect, test } from "vitest";
import { safeFileNameForPage } from "../src/page-writer";

describe("page writer filenames", () => {
	test("keeps normal sanitized page titles unchanged", () => {
		expect(safeFileNameForPage("Open Loops DB: Row?", "33e61ec2-14e6-81aa-b7db-ea6c37d79551")).toBe("Open Loops DB- Row-");
	});

	test("truncates overlong Notion titles and appends a page-id suffix", () => {
		const title = "[CLAUDE.md](http://claude.md/) patches for rounds skill integration — two patches needed: (1) §Session Boot Protocol new step between step 2 and step 3 to run rounds §2.3 (Bugs critical scan) and §2.5 (Abandoned Session Recovery) at boot; (2) pointer to rounds §3 for Claude-initiates-close rule. Skill file at ~/.claude/skills/rounds/SKILL.md cross-references both correctly. Patches are a follow-up build step.";
		const fileName = safeFileNameForPage(title, "33e61ec2-14e6-81aa-b7db-ea6c37d79551");

		expect(fileName).toContain("--33e61ec2");
		expect(new TextEncoder().encode(`${fileName}.md`).length).toBeLessThan(255);
		expect(fileName).not.toContain("/");
		expect(fileName).not.toContain(":");
	});
});
