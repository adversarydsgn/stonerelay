import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";

describe("lockfile no-write invariant", () => {
	it("has no source write calls directly targeting .next-id lockfile paths", () => {
		const src = ["src/database-freezer.ts", "src/main.ts", "src/page-writer.ts", "src/push.ts"].map((path) => readFileSync(path, "utf8")).join("\n");
		expect(src).not.toMatch(/(writeAtomic|modifyAtomic|vault\.(modify|create|delete))\([^)]*\.next-id(\.lock)?/);
	});
});
