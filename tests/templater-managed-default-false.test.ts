import { describe, expect, it } from "vitest";
import { createDatabaseEntry } from "../src/settings-data";

describe("templater_managed defaults", () => {
	it("creates new database entries with templater_managed false", () => {
		const entry = createDatabaseEntry({
			name: "Bugs",
			databaseId: "0123456789abcdef0123456789abcdef",
			outputFolder: "_relay/bugs",
		});

		expect(entry.templater_managed).toBe(false);
	});
});
