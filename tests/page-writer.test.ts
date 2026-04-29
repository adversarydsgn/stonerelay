import { describe, expect, test } from "vitest";
import { buildFileContent, safeFileNameForPage } from "../src/page-writer";

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

describe("standalone page content", () => {
	test("writes standalone page frontmatter fields and converted body", () => {
		const content = buildFileContent({
			"notion-id": "page-1",
			"notion-url": "https://www.notion.so/page-1",
			"notion-frozen-at": "2026-04-27T10:00:00.000Z",
			"notion-last-edited": "2026-04-27T09:00:00.000Z",
			"notion-parent-type": "workspace",
		}, "# Body\n");

		expect(content).toContain("notion-id: page-1");
		expect(content).toContain('notion-url: "https://www.notion.so/page-1"');
		expect(content).toContain('notion-frozen-at: "2026-04-27T10:00:00.000Z"');
		expect(content).toContain('notion-last-edited: "2026-04-27T09:00:00.000Z"');
		expect(content).toContain("notion-parent-type: workspace");
		expect(content).toContain("# Body");
	});

	test("omits empty frontmatter values while preserving non-empty values", () => {
		const content = buildFileContent({
			"notion-id": "page-1",
			EmptyArray: [],
			EmptyObject: {},
			Nil: null,
			Missing: undefined,
			EmptyString: "",
			FalseValue: false,
			ZeroValue: 0,
			Tags: ["one", "two"],
			ObjectValue: { start: "2026-04-29" },
			Text: "hello",
		}, "# Body\n");

		const frontmatter = content.slice(0, content.indexOf("---", 4));
		expect(frontmatter).not.toMatch(/:\s*\[\]\s*$/m);
		expect(frontmatter).not.toMatch(/:\s*\{\}\s*$/m);
		expect(frontmatter).not.toMatch(/:\s*null\s*$/m);
		expect(frontmatter).not.toMatch(/:\s*""\s*$/m);
		expect(frontmatter).not.toMatch(/:\s*''\s*$/m);
		expect(content).toContain("FalseValue: false");
		expect(content).toContain("ZeroValue: 0");
		expect(content).toContain("Tags:\n  - one\n  - two");
		expect(content).toContain('ObjectValue: "{\\"start\\":\\"2026-04-29\\"}"');
		expect(content).toContain("Text: hello");
	});
});
