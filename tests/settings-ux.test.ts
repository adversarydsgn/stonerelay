import { describe, expect, it, vi } from "vitest";
import {
	AUTO_SYNC_OVERRIDE_LABELS,
	autoSyncReadiness,
	databaseDirectionCounts,
	fetchDatabaseMetadata,
	groupedSyncEntries,
	lastEditSideIndicator,
	parseNotionDbId,
	parseNotionPageId,
	pendingConflictCount,
	slugify,
	syncHistoryTitle,
	syncedDatabasesHeader,
	trimApiKey,
} from "../src/settings-ux";

const rawId = "0123456789abcdef0123456789abcdef";

describe("parseNotionDbId", () => {
	it("extracts a database ID from Notion URLs", () => {
		expect(parseNotionDbId(`https://www.notion.so/myworkspace/${rawId}`)).toBe(rawId);
		expect(parseNotionDbId(`https://www.notion.so/myworkspace/${rawId}?v=abc`)).toBe(rawId);
	});

	it("accepts bare dashed and undashed IDs", () => {
		expect(parseNotionDbId("01234567-89ab-cdef-0123-456789abcdef")).toBe(rawId);
		expect(parseNotionDbId(rawId)).toBe(rawId);
	});

	it("rejects invalid inputs", () => {
		expect(parseNotionDbId("not-a-url")).toBeNull();
		expect(parseNotionDbId("https://example.com/foo")).toBeNull();
	});
});

describe("parseNotionPageId", () => {
	it("extracts page IDs from Notion URLs and UUID inputs", () => {
		expect(parseNotionPageId(`https://www.notion.so/workspace/Page-Title-${rawId}?pvs=4`)).toBe(rawId);
		expect(parseNotionPageId("01234567-89ab-cdef-0123-456789abcdef")).toBe(rawId);
		expect(parseNotionPageId(rawId)).toBe(rawId);
	});

	it("rejects invalid page inputs", () => {
		expect(parseNotionPageId("not-a-page")).toBeNull();
		expect(parseNotionPageId("https://example.com/0123456789abcdef0123456789abcdef")).toBeNull();
	});
});

describe("grouped sync entries", () => {
	it("places missing or null group entries into Ungrouped and preserves group sections", () => {
		const groups = [{ id: "group-1", name: "Active", collapsed: true }];
		const databases = [
			{ id: "db-1", groupId: "group-1" },
			{ id: "db-2", groupId: null },
		] as never;
		const pages = [
			{ id: "page-1", groupId: "missing" },
			{ id: "page-2", groupId: "group-1" },
		] as never;

		expect(groupedSyncEntries(groups, databases, pages)).toMatchObject([
			{ group: null, databases: [{ id: "db-2" }], pages: [{ id: "page-1" }] },
			{ group: { id: "group-1", collapsed: true }, databases: [{ id: "db-1" }], pages: [{ id: "page-2" }] },
		]);
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

describe("pegged row helpers", () => {
	it("makes auto-sync override labels self-explanatory", () => {
		expect(AUTO_SYNC_OVERRIDE_LABELS).toEqual({
			inherit: "Auto-sync: Inherit",
			on: "Auto-sync: On",
			off: "Auto-sync: Off",
		});
	});

	it("summarizes pegged, pull-only, and push-only counts", () => {
		const rows = [{ direction: "bidirectional" }, { direction: "pull" }, { direction: "push" }, { direction: "bidirectional" }] as const;

		expect(databaseDirectionCounts(rows)).toEqual({ pegged: 2, pullOnly: 1, pushOnly: 1 });
		expect(syncedDatabasesHeader(rows)).toBe("Synced databases · 2 pegged · 1 pull-only · 1 push-only");
	});

	it("shows conflict and auto-sync readiness state without inventing network-side edits", () => {
		const entry = {
			direction: "bidirectional",
			outputFolder: "_relay/sessions",
			current_phase: "phase_2",
			lastSyncStatus: "ok",
			current_sync_id: null,
		} as const;
		const conflicts = [{
			rowId: "row-1",
			notionEditedAt: "2026-04-27T01:00:00.000Z",
			vaultEditedAt: "2026-04-27T01:01:00.000Z",
			notionSnapshot: {},
			vaultSnapshot: {},
			detectedAt: "2026-04-27T01:02:00.000Z",
		}];

		expect(lastEditSideIndicator(entry, [])).toBe("=");
		expect(lastEditSideIndicator(entry, conflicts)).toBe("!");
		expect(pendingConflictCount(entry, conflicts)).toBe(1);
		expect(autoSyncReadiness(entry, conflicts)).toBe("Blocked: conflicts");
		expect(autoSyncReadiness({ ...entry, lastSyncStatus: "partial" }, [])).toBe("Blocked: partial");
	});

	it("uses persisted sync fields for history tooltip text", () => {
		expect(syncHistoryTitle({
			lastSyncedAt: "2026-04-27T01:00:00.000Z",
			lastPulledAt: "2026-04-27T01:00:00.000Z",
			lastPushedAt: null,
			lastSyncStatus: "partial",
			lastSyncError: "row-1 failed",
		})).toBe([
			"Last full sync: 2026-04-27T01:00:00.000Z",
			"Last successful pull: 2026-04-27T01:00:00.000Z",
			"Last successful push: Never",
			"Last status: partial",
			"Last error: row-1 failed",
		].join("\n"));
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
