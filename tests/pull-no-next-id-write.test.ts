import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";

describe("pull .next-id write invariant", () => {
	it("contains no source write call targeting .next-id", () => {
		const freezer = readFileSync("src/database-freezer.ts", "utf8");
		expect(freezer).not.toMatch(/(writeAtomic|modifyAtomic|vault\.(modify|create))\([^)]*\.next-id/);
	});
});
