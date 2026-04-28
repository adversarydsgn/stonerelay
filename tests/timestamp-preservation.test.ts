import { describe, expect, test, vi } from "vitest";
import { TFile, TFolder } from "obsidian";
import { frontmatterValueToNotionPayload, pushDatabase } from "../src/push";

describe("timestamp preservation", () => {
	test("user-set date properties survive Notion → vault → Notion", async () => {
		const date = "2026-04-21";
		expect(frontmatterValueToNotionPayload("date", "Date Decided", date)).toEqual({
			date: { start: date },
		});
	});

	test("Notion Created time preserved on push-update (matched by notion-id)", async () => {
		const baselineCreatedTime = "2026-01-15T12:00:00.000Z";
		const { app, client } = pushHarness([
			file("_relay/timestamp-test/row.md", "---\nnotion-id: page-1\nDate Decided: 2026-01-15\nStatus: Locked\n---\n# Timestamp Row 1"),
		], {
			results: [page("page-1", "Timestamp Row 1", baselineCreatedTime, "2026-01-15T12:05:00.000Z")],
			updateResult: page("page-1", "Timestamp Row 1", baselineCreatedTime, "2026-04-25T17:00:00.000Z"),
		});

		const result = await pushDatabase(app as never, client as never, "db-1", "_relay/timestamp-test", { reservationId: "test-reservation" });

		expect(client.pages.update).toHaveBeenCalledTimes(1);
		expect(client.pages.create).not.toHaveBeenCalled();
		expect(client.pages.update.mock.calls[0][0].page_id).toBe("page-1");
		expect(result.updated).toBe(1);
		const pushedPage = await client.pages.update.mock.results[0].value;
		expect(pushedPage.created_time).toBe(baselineCreatedTime);
	});

	test("Notion Last edited time bumps on push (expected)", async () => {
		const baselineEditedTime = "2026-01-15T12:05:00.000Z";
		const pushedEditedTime = "2026-04-25T17:00:00.000Z";
		const { app, client } = pushHarness([
			file("_relay/timestamp-test/row.md", "---\nnotion-id: page-1\nDate Decided: 2026-01-15\nStatus: Locked\n---\n# Timestamp Row 1"),
		], {
			results: [page("page-1", "Timestamp Row 1", "2026-01-15T12:00:00.000Z", baselineEditedTime)],
			updateResult: page("page-1", "Timestamp Row 1", "2026-01-15T12:00:00.000Z", pushedEditedTime),
		});

		await pushDatabase(app as never, client as never, "db-1", "_relay/timestamp-test", { reservationId: "test-reservation" });

		const pushedPage = await client.pages.update.mock.results[0].value;
		expect(Date.parse(pushedPage.last_edited_time)).toBeGreaterThan(Date.parse(baselineEditedTime));
	});

	test("Date range with start + end survives round-trip", async () => {
		expect(frontmatterValueToNotionPayload("date", "Date Decided", "2026-04-21 → 2026-04-25")).toEqual({
			date: { start: "2026-04-21", end: "2026-04-25" },
		});
	});

	test("Empty date property survives as null, not zero-time", async () => {
		expect(frontmatterValueToNotionPayload("date", "Date Decided", null)).toEqual({ date: null });
		expect(frontmatterValueToNotionPayload("date", "Date Decided", "")).toEqual({ date: null });
	});

	test("Timezone preserved in date property if source has one", async () => {
		expect(frontmatterValueToNotionPayload("date", "Date Decided", {
			start: "2026-04-21T14:30:00",
			end: null,
			time_zone: "America/Chicago",
		})).toEqual({
			date: {
				start: "2026-04-21T14:30:00",
				time_zone: "America/Chicago",
			},
		});
	});
});

function pushHarness(
	files: Array<{ file: TFile; content: string }>,
	options: {
		results: unknown[];
		updateResult?: unknown;
		createResult?: unknown;
	}
) {
	const folder = Object.assign(Object.create(TFolder.prototype), { path: "_relay/timestamp-test" });
	const app = {
		vault: {
			getAbstractFileByPath: vi.fn().mockReturnValue(folder),
			getMarkdownFiles: vi.fn().mockReturnValue(files.map((entry) => entry.file)),
			cachedRead: vi.fn(async (tfile: TFile) => files.find((entry) => entry.file === tfile)?.content ?? ""),
			modify: vi.fn(async (tfile: TFile, content: string) => {
				const entry = files.find((item) => item.file === tfile);
				if (entry) entry.content = content;
			}),
		},
	};
	const client = {
		databases: {
			retrieve: vi.fn().mockResolvedValue({
				title: [richText("Stonerelay Timestamp Test")],
				data_sources: [{ id: "source-1" }],
			}),
		},
		dataSources: {
			retrieve: vi.fn().mockResolvedValue({
				properties: {
					Title: { type: "title" },
					"Date Decided": { type: "date" },
					Status: { type: "select" },
					"Created time": { type: "created_time" },
					"Last edited time": { type: "last_edited_time" },
				},
			}),
			query: vi.fn().mockResolvedValue({ has_more: false, results: options.results }),
		},
		pages: {
			update: vi.fn().mockResolvedValue(options.updateResult ?? {}),
			create: vi.fn().mockResolvedValue(options.createResult ?? {}),
		},
	};
	return { app, client };
}

function file(path: string, content: string): { file: TFile; content: string } {
	const name = path.slice(path.lastIndexOf("/") + 1);
	return {
		file: Object.assign(Object.create(TFile.prototype), {
			path,
			name,
			basename: name.replace(/\.md$/, ""),
			extension: "md",
		}),
		content,
	};
}

function page(id: string, title: string, createdTime: string, lastEditedTime: string) {
	return {
		object: "page",
		id,
		created_time: createdTime,
		last_edited_time: lastEditedTime,
		properties: {
			Title: {
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
		text: {
			content,
			link: null,
		},
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
