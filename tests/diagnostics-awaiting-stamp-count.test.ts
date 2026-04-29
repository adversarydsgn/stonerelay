import { describe, expect, it } from "vitest";
import { countAwaitingIdStamp } from "../src/vault-canonical";

describe("vault canonical awaiting-stamp count", () => {
	it("counts files with notion-id but no vault ID", () => {
		expect(countAwaitingIdStamp([
			{ path: "_relay/A/one.md", frontmatter: { "notion-id": "page-1" } },
			{ path: "_relay/A/two.md", frontmatter: { "notion-id": "page-2", ID: "DEC-2" } },
			{ path: "_relay/B/three.md", frontmatter: { "notion-id": "page-3" } },
		], "_relay/A")).toBe(1);
	});
});
