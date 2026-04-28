import { describe, expect, it, vi } from "vitest";
import { TFile, TFolder } from "obsidian";
import { refreshDatabase, scanLocalFiles } from "../src/database-freezer";

describe("pull safety scan and backfill", () => {
	it("isolates deletion candidates by notion-id plus notion-database-id", async () => {
		const files = [
			file("_relay/A/a.md", { "notion-id": "row-a", "notion-database-id": "db-a" }),
			file("_relay/A/B/b.md", { "notion-id": "row-b", "notion-database-id": "db-b" }),
		];
		const app = appWithFiles(files);

		const scan = await scanLocalFiles(app as never, "_relay/A", "db-a");

		expect([...scan.files.keys()]).toEqual(["row-a"]);
		expect(scan.files.has("row-b")).toBe(false);
	});

	it("warns when multiple local files claim the same notion-id for one database", async () => {
		const files = [
			file("_relay/A/one.md", { "notion-id": "row-a", "notion-database-id": "db-a" }),
			file("_relay/A/two.md", { "notion-id": "row-a", "notion-database-id": "db-a" }),
		];

		const scan = await scanLocalFiles(appWithFiles(files) as never, "_relay/A", "db-a");

		expect(scan.duplicateWarnings[0]).toContain("2 local files claiming notion-id row-a");
	});

	it("backfills legacy notion-database-id during Pull when a legacy file matches the current row", async () => {
		const legacy = file("_relay/A/legacy.md", { "notion-id": "row-a", "notion-last-edited": "old" }, "---\nnotion-id: row-a\nnotion-last-edited: old\n---\nOld");
		const app = appWithFiles([legacy]);
		const adapter = app.vault.adapter;
		const client = notionClient([page("row-a", "Legacy")]);

		const result = await refreshDatabase(app as never, client as never, {
			databaseId: "db-a",
			title: "A",
			folderPath: "_relay/A",
			entryCount: 1,
		});

		expect(result.backfilled).toBe(1);
		expect([...adapter.files.values()].join("\n")).toContain("notion-database-id: db-a");
	});
});

function appWithFiles(files: ReturnType<typeof file>[]) {
	const folder = Object.assign(Object.create(TFolder.prototype), { path: "_relay/A", children: files.map((entry) => entry.file) });
	const adapter = {
		files: new Map(files.map((entry) => [entry.file.path, entry.content])),
		async write(path: string, data: string) {
			adapter.files.set(path, data);
		},
		async read(path: string) {
			return adapter.files.get(path) ?? "";
		},
		async rename(from: string, to: string) {
			const data = adapter.files.get(from);
			if (data === undefined) throw new Error("missing temp");
			adapter.files.set(to, data);
			adapter.files.delete(from);
		},
		async remove(path: string) {
			adapter.files.delete(path);
		},
	};
	return {
		vault: {
			adapter,
			getAbstractFileByPath: vi.fn((path: string) => path === "_relay/A" ? folder : files.find((entry) => entry.file.path === path)?.file ?? null),
			getMarkdownFiles: vi.fn().mockReturnValue(files.map((entry) => entry.file)),
			read: vi.fn(async (tfile: TFile) => adapter.files.get(tfile.path) ?? ""),
		},
		metadataCache: {
			getFileCache: vi.fn((tfile: TFile) => ({
				frontmatter: files.find((entry) => entry.file === tfile)?.frontmatter ?? {},
			})),
		},
	};
}

function file(path: string, frontmatter: Record<string, unknown>, content = "") {
	const name = path.slice(path.lastIndexOf("/") + 1);
	return {
		file: Object.assign(Object.create(TFile.prototype), {
			path,
			name,
			basename: name.replace(/\.md$/, ""),
			extension: "md",
			stat: { mtime: 1 },
		}),
		frontmatter,
		content: content || `---\n${Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`).join("\n")}\n---\nBody`,
	};
}

function notionClient(results: unknown[]) {
	return {
		databases: {
			retrieve: vi.fn().mockResolvedValue({
				title: [richText("A")],
				data_sources: [{ id: "source-a" }],
			}),
		},
		dataSources: {
			retrieve: vi.fn().mockResolvedValue({
				title: [richText("A")],
				properties: { Name: { type: "title" } },
			}),
			query: vi.fn().mockResolvedValue({ has_more: false, results }),
		},
		blocks: {
			children: {
				list: vi.fn().mockResolvedValue({ has_more: false, results: [] }),
			},
		},
	};
}

function page(id: string, title: string) {
	return {
		object: "page",
		id,
		url: `https://notion.so/${id}`,
		last_edited_time: "2026-04-27T10:00:00.000Z",
		properties: {
			Name: {
				type: "title",
				title: [richText(title)],
			},
		},
	};
}

function richText(content: string) {
	return {
		type: "text",
		plain_text: content,
		text: { content, link: null },
		annotations: {
			bold: false,
			italic: false,
			strikethrough: false,
			underline: false,
			code: false,
			color: "default",
		},
		href: null,
	};
}
