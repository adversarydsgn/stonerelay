import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";

describe("unique_id extraction source of truth", () => {
	it("uses the shared extractor from both pull and push canonicalization paths", () => {
		const helper = readFileSync("src/notion-property-utils.ts", "utf8");
		const push = readFileSync("src/push.ts", "utf8");
		const pageWriter = readFileSync("src/page-writer.ts", "utf8");
		const allSrc = [helper, push, pageWriter].join("\n");

		expect(allSrc.match(/function extractUniqueId/g)).toHaveLength(1);
		expect(push).toContain('extractUniqueId(source["properties"])');
		expect(pageWriter).toContain("extractUniqueId(prop)");
		expect(allSrc).not.toMatch(/uid\.prefix\s*\?\s*`\$\{uid\.prefix\}-\$\{uid\.number\}`/);
	});
});
