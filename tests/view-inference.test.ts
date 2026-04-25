import { describe, expect, it } from "vitest";
import { buildBaseFile, inferDefaultViews, InferredViews, NotionDbSchema, PulledRow } from "../src/view-inference";

function schema(properties: NotionDbSchema): NotionDbSchema {
	return { properties: properties as Record<string, { type: string }> };
}

function row(frontmatter: Record<string, unknown>): PulledRow {
	return { frontmatter };
}

describe("inferDefaultViews", () => {
	it("detects standard date property", () => {
		const inferred = inferDefaultViews(
			[row({ "Date Decided": "2026-04-25" })],
			schema({ "Date Decided": { type: "date" } })
		);

		expect(inferred.dateProperty).toBe("Date Decided");
	});

	it("detects creator-style date properties", () => {
		const inferred = inferDefaultViews(
			[row({ "notion-created-time": "2026-04-25T15:00:00.000Z" })],
			schema({ "notion-created-time": { type: "created_time" } })
		);

		expect(inferred.dateProperty).toBe("notion-created-time");
	});

	it("detects Resolved boolean and marks open as false", () => {
		const inferred = inferDefaultViews(
			[row({ Resolved: false })],
			schema({ Resolved: { type: "checkbox" } })
		);

		expect(inferred.statusProperty).toEqual({
			name: "Resolved",
			type: "boolean",
			openValue: false,
		});
	});

	it("detects Status select with Open value", () => {
		const inferred = inferDefaultViews(
			[row({ Status: "Open" })],
			schema({
				Status: {
					type: "select",
					select: { options: [{ name: "Open" }, { name: "Closed" }] },
				},
			})
		);

		expect(inferred.statusProperty).toEqual({
			name: "Status",
			type: "select",
			openValue: "Open",
		});
	});

	it("detects Severity multi_select as categorical", () => {
		const inferred = inferDefaultViews(
			[row({ Severity: ["High"] })],
			schema({ Severity: { type: "multi_select" } })
		);

		expect(inferred.categoryProperty).toBe("Severity");
	});

	it("uses date priority when multiple date properties exist", () => {
		const inferred = inferDefaultViews(
			[
				row({
					"Created time": "2026-04-20T00:00:00.000Z",
					"Date Locked": "2026-04-24",
					"Date Decided": "2026-04-25",
				}),
			],
			schema({
				"Created time": { type: "created_time" },
				"Date Locked": { type: "date" },
				"Date Decided": { type: "date" },
			})
		);

		expect(inferred.dateProperty).toBe("Date Decided");
	});

	it("returns nulls when no properties match", () => {
		const inferred = inferDefaultViews(
			[row({ Name: "Untitled", Count: 3 })],
			schema({ Name: { type: "title" }, Count: { type: "number" } })
		);

		expect(inferred).toEqual({
			dateProperty: null,
			statusProperty: null,
			categoryProperty: null,
		});
	});

	it("keeps property names with spaces and special characters intact", () => {
		const inferred = inferDefaultViews(
			[row({ "Date #": "2026-04-25", "Done?": false })],
			schema({
				"Date #": { type: "date" },
				"Done?": { type: "checkbox" },
			})
		);

		expect(inferred.dateProperty).toBe("Date #");
		expect(inferred.statusProperty?.name).toBe("Done?");
	});
});

describe("buildBaseFile", () => {
	it("builds a full inferred .base file", () => {
		const inferred: InferredViews = {
			dateProperty: "Date Decided",
			statusProperty: { name: "Status", type: "select", openValue: "Open" },
			categoryProperty: "Severity",
		};

		expect(buildBaseFile(inferred, {
			folderPath: "_relay/sessions",
			notionId: "abc123",
			order: ["ID", "Date Decided", "Status", "Severity", "Session #", "Owner"],
		})).toMatchInlineSnapshot(`
			"filters:
			  and:
			    - file.inFolder("_relay/sessions")
			    - 'note["notion-database-id"] == "abc123"'
			
			views:
			  - type: table
			    name: Recent
			    sort:
			      - property: "Date Decided"
			        direction: DESC
			    order:
			      - "ID"
			      - "Date Decided"
			      - "Status"
			      - "Severity"
			      - "Session #"
			      - "Owner"
			
			  - type: table
			    name: Open
			    filters:
			      and:
			        - 'note["Status"] == "Open"'
			    sort:
			      - property: "Date Decided"
			        direction: DESC
			    order:
			      - "ID"
			      - "Date Decided"
			      - "Status"
			      - "Severity"
			      - "Session #"
			      - "Owner"
			
			  - type: table
			    name: By Severity
			    sort:
			      - property: "Date Decided"
			        direction: DESC
			    group_by: "Severity"
			    order:
			      - "ID"
			      - "Date Decided"
			      - "Status"
			      - "Session #"
			      - "Owner"
			
			  - type: table
			    name: All entries
			    order:
			      - "ID"
			      - "Date Decided"
			      - "Status"
			      - "Severity"
			      - "Session #"
			      - "Owner"
			"
		`);
	});

	it("builds a minimal one-view .base file without inferred properties", () => {
		const inferred: InferredViews = {
			dateProperty: null,
			statusProperty: null,
			categoryProperty: null,
		};

		expect(buildBaseFile(inferred, {
			folderPath: "_relay/plain",
			notionId: "abc123",
			order: ["Status", "Session #"],
		})).toMatchInlineSnapshot(`
			"filters:
			  and:
			    - file.inFolder("_relay/plain")
			    - 'note["notion-database-id"] == "abc123"'
			
			views:
			  - type: table
			    name: All entries
			    order:
			      - "Status"
			      - "Session #"
			"
		`);
	});
});
