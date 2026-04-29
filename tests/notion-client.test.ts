import { describe, expect, it } from "vitest";
import { createNotionClient } from "../src/notion-client";

describe("createNotionClient", () => {
	it("requires an explicit fetch implementation", () => {
		expect(() => createNotionClient("ntn_test")).toThrow("createNotionClient requires options.fetch");
	});
});
