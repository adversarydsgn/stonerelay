import { describe, expect, it, vi } from "vitest";
import { TFile, TFolder } from "obsidian";
import { createTestReservationContext } from "./test-reservation-context";
import { refreshDatabase } from "../src/database-freezer";

describe("templater_managed pull loop plumbing", () => {
	it("routes templaterManaged through refresh decisions and surfaces a conflict", async () => {
		const localFile = file("_relay/bugs/Row.md", Date.parse("2026-04-29T10:05:00.000Z"));
		const onConflict = vi.fn();
		const app = {
			vault: {
				adapter: {
					write: vi.fn(async () => undefined),
					rename: vi.fn(async () => undefined),
				},
				getAbstractFileByPath: vi.fn((path: string) =>
					path === "_relay/bugs" ? folder("_relay/bugs") : null
				),
				getMarkdownFiles: vi.fn(() => [localFile]),
				read: vi.fn(async () => ""),
			},
			metadataCache: {
				getFileCache: vi.fn(() => ({
					frontmatter: {
						"notion-id": "page-1",
						"notion-database-id": "0123456789abcdef0123456789abcdef",
						"notion-last-edited": "2026-04-29T10:01:00.000Z",
					},
				})),
			},
		};
		const client = {
			databases: {
				retrieve: vi.fn(async () => ({
					title: [richText("Bugs")],
					data_sources: [{ id: "source-1" }],
				})),
			},
			dataSources: {
				retrieve: vi.fn(async () => ({
					title: [richText("Bugs")],
					properties: { Name: { type: "title" } },
				})),
				query: vi.fn(async () => ({
					has_more: false,
					results: [{
						object: "page",
						id: "page-1",
						last_edited_time: "2026-04-29T10:10:00.000Z",
						properties: {},
					}],
				})),
			},
		};

		await refreshDatabase(app as never, client as never, {
			databaseId: "0123456789abcdef0123456789abcdef",
			folderPath: "_relay/bugs",
		}, "2026-04-29T10:00:00.000Z", undefined, {
			context: createTestReservationContext("templater-pull") as never,
			bidirectional: {
				sourceOfTruth: "notion",
				templaterManaged: true,
				lastSyncedAt: "2026-04-29T10:00:00.000Z",
				onConflict,
			},
		});

		expect(onConflict).toHaveBeenCalledWith(expect.objectContaining({
			rowId: "page-1",
			notionSnapshot: expect.objectContaining({ id: "page-1" }),
		}));
	});
});

function folder(path: string): TFolder {
	return Object.assign(Object.create(TFolder.prototype), { path, children: [] });
}

function file(path: string, mtime: number): TFile {
	return Object.assign(Object.create(TFile.prototype), {
		path,
		name: path.split("/").pop() ?? path,
		basename: "Row",
		extension: "md",
		stat: { mtime },
	});
}

function richText(content: string) {
	return {
		type: "text",
		plain_text: content,
		text: { content },
		href: null,
		annotations: {
			bold: false,
			italic: false,
			strikethrough: false,
			underline: false,
			code: false,
			color: "default",
		},
	};
}
