import { describe, expect, it, vi } from "vitest";
import {
	fetchDatabaseMetadata,
	parseNotionDbId,
	slugify,
	trimApiKey,
} from "../src/settings-ux";

const rawId = "00000000000000000000000000000000";

describe("parseNotionDbId", () => {
	it("extracts a database ID from Notion URLs", () => {
		expect(parseNotionDbId(`https://www.notion.so/myworkspace/${rawId}`)).toBe(rawId);
		expect(parseNotionDbId(`https://www.notion.so/myworkspace/${rawId}?v=abc`)).toBe(rawId);
	});

	it("accepts bare dashed and undashed IDs", () => {
		expect(parseNotionDbId("00000000-0000-4000-8000-000000000000")).toBe(rawId);
		expect(parseNotionDbId(rawId)).toBe(rawId);
	});

	it("rejects invalid inputs", () => {
		expect(parseNotionDbId("not-a-url")).toBeNull();
		expect(parseNotionDbId("https://example.com/foo")).toBeNull();
	});
});

describe("slugify", () => {
	it("creates lowercase hyphenated folder slugs", () => {
		expect(slugify("Friction Log")).toBe("friction-log");
		expect(slugify("My Cool DB!")).toBe("my-cool-db");
		expect(slugify("   spaces   ")).toBe("spaces");
	});

	it("handles empty and symbol-only strings", () => {
		expect(slugify("")).toBe("");
		expect(slugify("!@#$%^&*()")).toBe("");
	});
});

describe("trimApiKey", () => {
	it("strips leading and trailing whitespace", () => {
		expect(trimApiKey("  ntn_secret  \n")).toBe("ntn_secret");
	});

	it("preserves internal characters and handles empty strings", () => {
		expect(trimApiKey("ntn_secret with space")).toBe("ntn_secret with space");
		expect(trimApiKey("   ")).toBe("");
	});
});

describe("fetchDatabaseMetadata", () => {
	it("returns title, property count, and exact row count", async () => {
		const client = clientWith({
			retrieve: vi.fn().mockResolvedValue({
				title: [{ plain_text: "Friction" }, { plain_text: " Log" }],
				data_sources: [{ id: "source-id" }],
			}),
			dataSourceRetrieve: vi.fn().mockResolvedValue({
				properties: { Name: {}, Status: {} },
			}),
			dataSourceQuery: vi.fn().mockResolvedValue({
				has_more: false,
				results: [{}, {}, {}],
			}),
		});

		await expect(fetchDatabaseMetadata(rawId, client)).resolves.toEqual({
			ok: true,
			metadata: {
				title: "Friction Log",
				propertyCount: 2,
				rowCount: "3",
				rowCountApproximate: false,
			},
		});
	});

	it("reports 100+ rows when the first page has more", async () => {
		const client = clientWith({
			retrieve: vi.fn().mockResolvedValue({
				title: [{ plain_text: "Big DB" }],
				data_sources: [{ id: "source-id" }],
			}),
			dataSourceRetrieve: vi.fn().mockResolvedValue({
				properties: {},
			}),
			dataSourceQuery: vi.fn().mockResolvedValue({
				has_more: true,
				results: new Array(100).fill({}),
			}),
		});

		const result = await fetchDatabaseMetadata(rawId, client);
		expect(result).toMatchObject({
			ok: true,
			metadata: {
				rowCount: "100+",
				rowCountApproximate: true,
			},
		});
	});

	it("returns structured errors for 401, 404, and network failures", async () => {
		for (const error of [
			Object.assign(new Error("Unauthorized"), { status: 401 }),
			Object.assign(new Error("Not found"), { status: 404 }),
			new Error("Network unavailable"),
		]) {
			const client = clientWith({
				retrieve: vi.fn().mockRejectedValue(error),
				dataSourceRetrieve: vi.fn(),
				dataSourceQuery: vi.fn(),
			});

			const result = await fetchDatabaseMetadata(rawId, client);
			expect(result.ok).toBe(false);
			expect(result).toHaveProperty("error");
		}
	});

	it("keeps title metadata when row count query fails", async () => {
		const client = clientWith({
			retrieve: vi.fn().mockResolvedValue({
				title: [{ plain_text: "Reachable DB" }],
				data_sources: [{ id: "source-id" }],
			}),
			dataSourceRetrieve: vi.fn().mockResolvedValue({
				properties: { Name: {} },
			}),
			dataSourceQuery: vi.fn().mockRejectedValue(new Error("Rate limited")),
		});

		await expect(fetchDatabaseMetadata(rawId, client)).resolves.toEqual({
			ok: true,
			metadata: {
				title: "Reachable DB",
				propertyCount: 1,
			},
		});
	});
});

function clientWith(methods: {
	retrieve: unknown;
	dataSourceRetrieve: unknown;
	dataSourceQuery: unknown;
}) {
	return {
		databases: {
			retrieve: methods.retrieve,
		},
		dataSources: {
			retrieve: methods.dataSourceRetrieve,
			query: methods.dataSourceQuery,
		},
	} as never;
}
