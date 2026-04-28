import { describe, expect, it, vi } from "vitest";
import { TFile, TFolder } from "obsidian";
import {
	chunkText,
	frontmatterValueToNotionPayload,
	parseFrontmatter,
	pushDatabase,
	PushContext,
} from "../src/push";
import { ReservationManager } from "../src/reservations";

function ctx(): PushContext {
	return {
		titleToPageId: new Map([["Existing Relation", "rel-1"]]),
		titleToNotionId: new Map(),
		notionIdToPageId: new Map(),
		warnings: [],
	};
}

describe("push property handlers", () => {
	it("converts happy path writable property types", () => {
		const relationCtx = ctx();
		expect(frontmatterValueToNotionPayload("title", "Name", "Bug 57")).toEqual({
			title: [{ type: "text", text: { content: "Bug 57" } }],
		});
		expect(frontmatterValueToNotionPayload("rich_text", "Notes", "Long note")).toEqual({
			rich_text: [{ type: "text", text: { content: "Long note" } }],
		});
		expect(frontmatterValueToNotionPayload("number", "Score", "12")).toEqual({ number: 12 });
		expect(frontmatterValueToNotionPayload("select", "Type", "Bug")).toEqual({ select: { name: "Bug" } });
		expect(frontmatterValueToNotionPayload("multi_select", "Tags", ["UX", "API"])).toEqual({
			multi_select: [{ name: "UX" }, { name: "API" }],
		});
		expect(frontmatterValueToNotionPayload("status", "Status", "Done")).toEqual({ status: { name: "Done" } });
		expect(frontmatterValueToNotionPayload("date", "Due", "2026-04-25")).toEqual({ date: { start: "2026-04-25" } });
		expect(frontmatterValueToNotionPayload("checkbox", "Shipped", "yes")).toEqual({ checkbox: true });
		expect(frontmatterValueToNotionPayload("url", "URL", "https://example.com")).toEqual({ url: "https://example.com" });
		expect(frontmatterValueToNotionPayload("email", "Email", "a@example.com")).toEqual({ email: "a@example.com" });
		expect(frontmatterValueToNotionPayload("phone_number", "Phone", "555-0100")).toEqual({ phone_number: "555-0100" });
		expect(frontmatterValueToNotionPayload("relation", "Related", ["[[Existing Relation]]"], relationCtx)).toEqual({
			relation: [{ id: "rel-1" }],
		});
	});

	it("handles edge cases and skips read-only or complex types", () => {
		const relationCtx = ctx();
		expect(frontmatterValueToNotionPayload("number", "Score", "nope")).toBeUndefined();
		expect(frontmatterValueToNotionPayload("multi_select", "Tags", "")).toBeUndefined();
		expect(frontmatterValueToNotionPayload("status", "Status", "Todo")).not.toHaveProperty("select");
		expect(frontmatterValueToNotionPayload("date", "Range", "2026-04-25 → 2026-04-26")).toEqual({
			date: { start: "2026-04-25", end: "2026-04-26" },
		});
		expect(frontmatterValueToNotionPayload("checkbox", "Shipped", "false")).toEqual({ checkbox: false });
		expect(frontmatterValueToNotionPayload("relation", "Related", "[[Missing]]", relationCtx)).toBeUndefined();
		expect(relationCtx.warnings[0]).toContain("Unresolved relation");

		for (const type of ["people", "files", "formula", "rollup", "unique_id", "created_time", "created_by", "last_edited_time", "last_edited_by", "button", "verification"]) {
			expect(frontmatterValueToNotionPayload(type, "Read only", "value")).toBeUndefined();
		}
	});

	it("chunks rich text over 1900 chars on safe boundaries", () => {
		const long = `${"a".repeat(1200)}. ${"b".repeat(900)}. ${"c".repeat(50)}`;
		const chunks = chunkText(long);
		expect(chunks).toHaveLength(2);
		expect(chunks[0].text.content.length).toBeLessThanOrEqual(1900);
		expect(chunks[0].text.content.endsWith(".")).toBe(true);
		expect(chunks.map((chunk) => chunk.text.content).join(" ").length).toBe(long.length);
	});
});

describe("frontmatter parser", () => {
	it("parses scalars, arrays, and body content", () => {
		expect(parseFrontmatter("---\nStatus: Done\nTags:\n  - UX\n  - API\nCount: 2\n---\n# Body")).toEqual({
			props: {
				Status: "Done",
				Tags: ["UX", "API"],
				Count: 2,
			},
			body: "# Body",
		});
	});
});

describe("pushDatabase integration", () => {
	it("pushes 3 rows with 2 patches and 1 create against a mocked Notion API", async () => {
		const folder = Object.assign(Object.create(TFolder.prototype), { path: "_relay/bugs" });
		const files = [
			file("_relay/bugs/one.md", "---\nnotion-id: page-1\nStatus: Done\nScore: 1\n---\n# One"),
			file("_relay/bugs/two.md", "---\nStatus: Todo\nScore: 2\n---\n# Two"),
			file("_relay/bugs/three.md", "---\nStatus: Doing\nScore: 3\n---\n# Three"),
		];
		const app = {
			vault: {
				adapter: {
					write: vi.fn(async () => undefined),
					rename: vi.fn(async () => undefined),
					remove: vi.fn(async () => undefined),
				},
				getAbstractFileByPath: vi.fn().mockReturnValue(folder),
				getMarkdownFiles: vi.fn().mockReturnValue(files.map((entry) => entry.file)),
				cachedRead: vi.fn(async (tfile: TFile) => files.find((entry) => entry.file === tfile)?.content ?? ""),
				modify: vi.fn(async (tfile: TFile, content: string) => {
					const entry = files.find((item) => item.file === tfile);
					if (entry) entry.content = content;
				}),
			},
		};
		const update = vi.fn().mockResolvedValue({});
		const create = vi.fn().mockResolvedValue({});
		const client = {
			databases: {
				retrieve: vi.fn().mockResolvedValue({
					title: [richText("Bugs")],
					data_sources: [{ id: "source-1" }],
				}),
			},
			dataSources: {
				retrieve: vi.fn().mockResolvedValue({
					properties: {
						Name: { type: "title" },
						Status: { type: "status" },
						Score: { type: "number" },
					},
				}),
				query: vi.fn().mockResolvedValue({
					has_more: false,
					results: [
						page("page-1", "One"),
						page("page-2", "Two"),
					],
				}),
			},
			pages: { update, create },
		};

		const result = await withPushReservation((reservationId) =>
			pushDatabase(app as never, client as never, "db-1", "_relay/bugs", { reservationId })
		);

		expect(update).toHaveBeenCalledTimes(2);
		expect(update.mock.calls.map(([arg]) => arg.page_id)).toEqual(["page-1", "page-2"]);
		expect(create).toHaveBeenCalledTimes(1);
		expect(create.mock.calls[0][0].properties.Status).toEqual({ status: { name: "Doing" } });
		expect(result).toMatchObject({
			total: 3,
			created: 1,
			updated: 2,
			failed: 0,
		});
	});

	it("continues pushing rows after one Notion write fails", async () => {
		const folder = Object.assign(Object.create(TFolder.prototype), { path: "_relay/bugs" });
		const files = [
			file("_relay/bugs/one.md", "---\nStatus: Done\n---\n# One"),
			file("_relay/bugs/two.md", "---\nStatus: Todo\n---\n# Two"),
		];
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
					title: [richText("Bugs")],
					data_sources: [{ id: "source-1" }],
				}),
			},
			dataSources: {
				retrieve: vi.fn().mockResolvedValue({
					properties: {
						Name: { type: "title" },
						Status: { type: "status" },
					},
				}),
				query: vi.fn().mockResolvedValue({ has_more: false, results: [] }),
			},
			pages: {
				update: vi.fn(),
				create: vi.fn()
					.mockRejectedValueOnce(new Error("Notion rejected row"))
					.mockResolvedValueOnce({}),
			},
		};

		const result = await withPushReservation((reservationId) =>
			pushDatabase(app as never, client as never, "db-1", "_relay/bugs", { reservationId })
		);

		expect(client.pages.create).toHaveBeenCalledTimes(2);
		expect(result.created).toBe(1);
		expect(result.failed).toBe(1);
		expect(result.errors[0]).toContain("Notion rejected row");
	});

	it("skips stale notion-id rows instead of creating duplicates after operator confirmation", async () => {
		const folder = Object.assign(Object.create(TFolder.prototype), { path: "_relay/bugs" });
		const files = [
			file("_relay/bugs/stale.md", "---\nnotion-id: missing-page\nStatus: Done\n---\n# Stale"),
		];
		const app = {
			vault: {
				getAbstractFileByPath: vi.fn().mockReturnValue(folder),
				getMarkdownFiles: vi.fn().mockReturnValue(files.map((entry) => entry.file)),
				cachedRead: vi.fn(async (tfile: TFile) => files.find((entry) => entry.file === tfile)?.content ?? ""),
			},
		};
		const client = {
			databases: {
				retrieve: vi.fn().mockResolvedValue({
					title: [richText("Bugs")],
					data_sources: [{ id: "source-1" }],
				}),
			},
			dataSources: {
				retrieve: vi.fn().mockResolvedValue({
					properties: {
						Name: { type: "title" },
						Status: { type: "status" },
					},
				}),
				query: vi.fn().mockResolvedValue({ has_more: false, results: [] }),
			},
			pages: {
				update: vi.fn(),
				create: vi.fn(),
			},
		};

		const result = await withPushReservation((reservationId) => pushDatabase(app as never, client as never, "db-1", "_relay/bugs", {
			reservationId,
			allowStaleNotionIdThresholdProceed: true,
		}));

		expect(client.pages.update).not.toHaveBeenCalled();
		expect(client.pages.create).not.toHaveBeenCalled();
		expect(result.skipped).toBe(1);
		expect(result.errors[0]).toContain("notion-id missing-page was not found");
	});

	it("requires stale notion-id threshold confirmation before Notion mutation", async () => {
		const folder = Object.assign(Object.create(TFolder.prototype), { path: "_relay/bugs" });
		const files = Array.from({ length: 10 }, (_, index) =>
			file(
				`_relay/bugs/${index}.md`,
				index < 5
					? `---\nnotion-id: missing-page-${index}\nStatus: Done\n---\n# Stale ${index}`
					: `---\nStatus: Done\n---\n# New ${index}`
			)
		);
		const app = {
			vault: {
				getAbstractFileByPath: vi.fn().mockReturnValue(folder),
				getMarkdownFiles: vi.fn().mockReturnValue(files.map((entry) => entry.file)),
				cachedRead: vi.fn(async (tfile: TFile) => files.find((entry) => entry.file === tfile)?.content ?? ""),
			},
		};
		const client = {
			databases: {
				retrieve: vi.fn().mockResolvedValue({
					title: [richText("Bugs")],
					data_sources: [{ id: "source-1" }],
				}),
			},
			dataSources: {
				retrieve: vi.fn().mockResolvedValue({
					properties: {
						Name: { type: "title" },
						Status: { type: "status" },
					},
				}),
				query: vi.fn().mockResolvedValue({ has_more: false, results: [] }),
			},
			pages: {
				update: vi.fn(),
				create: vi.fn(),
			},
		};

		await expect(withPushReservation((reservationId) =>
			pushDatabase(app as never, client as never, "db-1", "_relay/bugs", { reservationId })
		))
			.rejects.toThrow("stale notion-id confirmation required");
		expect(client.pages.update).not.toHaveBeenCalled();
		expect(client.pages.create).not.toHaveBeenCalled();
	});

	it("blocks files with mismatched notion-database-id before Notion writes", async () => {
		const folder = Object.assign(Object.create(TFolder.prototype), { path: "_relay/bugs" });
		const files = [
			file("_relay/bugs/wrong.md", "---\nnotion-database-id: 11111111111141118111111111111111\nStatus: Done\n---\n# Wrong DB"),
		];
		const app = {
			vault: {
				getAbstractFileByPath: vi.fn().mockReturnValue(folder),
				getMarkdownFiles: vi.fn().mockReturnValue(files.map((entry) => entry.file)),
				cachedRead: vi.fn(async (tfile: TFile) => files.find((entry) => entry.file === tfile)?.content ?? ""),
			},
		};
		const client = {
			databases: {
				retrieve: vi.fn().mockResolvedValue({
					title: [richText("Bugs")],
					data_sources: [{ id: "source-1" }],
				}),
			},
			dataSources: {
				retrieve: vi.fn().mockResolvedValue({
					properties: {
						Name: { type: "title" },
						Status: { type: "status" },
					},
				}),
				query: vi.fn().mockResolvedValue({ has_more: false, results: [] }),
			},
			pages: {
				update: vi.fn(),
				create: vi.fn(),
			},
		};

		await expect(withPushReservation((reservationId) =>
			pushDatabase(app as never, client as never, "21b39452dc7b4a159d6b7b229c21cc80", "_relay/bugs", { reservationId }),
			"21b39452dc7b4a159d6b7b229c21cc80"
		))
			.rejects.toThrow("Push blocked before Notion write");
		expect(client.pages.update).not.toHaveBeenCalled();
		expect(client.pages.create).not.toHaveBeenCalled();
	});

	it("blocks duplicate notion-id files before any Notion write", async () => {
		const folder = Object.assign(Object.create(TFolder.prototype), { path: "_relay/bugs" });
		const files = [
			file("_relay/bugs/one.md", "---\nnotion-id: page-1\nStatus: Done\n---\n# One"),
			file("_relay/bugs/two.md", "---\nnotion-id: page-1\nStatus: Todo\n---\n# Two"),
		];
		const app = {
			vault: {
				getAbstractFileByPath: vi.fn().mockReturnValue(folder),
				getMarkdownFiles: vi.fn().mockReturnValue(files.map((entry) => entry.file)),
				cachedRead: vi.fn(async (tfile: TFile) => files.find((entry) => entry.file === tfile)?.content ?? ""),
			},
		};
		const client = {
			databases: {
				retrieve: vi.fn().mockResolvedValue({
					title: [richText("Bugs")],
					data_sources: [{ id: "source-1" }],
				}),
			},
			dataSources: {
				retrieve: vi.fn().mockResolvedValue({
					properties: {
						Name: { type: "title" },
						Status: { type: "status" },
					},
				}),
				query: vi.fn().mockResolvedValue({ has_more: false, results: [page("page-1", "One")] }),
			},
			pages: {
				update: vi.fn(),
				create: vi.fn(),
			},
		};

		await expect(withPushReservation((reservationId) =>
			pushDatabase(app as never, client as never, "db-1", "_relay/bugs", { reservationId })
		))
			.rejects.toThrow("duplicate notion-id values");
		expect(client.pages.update).not.toHaveBeenCalled();
		expect(client.pages.create).not.toHaveBeenCalled();
	});

	it("records push intent phases around create-before-frontmatter commits", async () => {
		const folder = Object.assign(Object.create(TFolder.prototype), { path: "_relay/bugs" });
		const files = [
			file("_relay/bugs/new.md", "---\nStatus: Doing\n---\n# New"),
		];
		const phases: string[] = [];
		const app = {
			vault: {
				adapter: {
					write: vi.fn(async () => undefined),
					rename: vi.fn(async () => undefined),
					remove: vi.fn(async () => undefined),
				},
				getAbstractFileByPath: vi.fn().mockReturnValue(folder),
				getMarkdownFiles: vi.fn().mockReturnValue(files.map((entry) => entry.file)),
				cachedRead: vi.fn(async (tfile: TFile) => files.find((entry) => entry.file === tfile)?.content ?? ""),
			},
		};
		const client = {
			databases: {
				retrieve: vi.fn().mockResolvedValue({
					title: [richText("Bugs")],
					data_sources: [{ id: "source-1" }],
				}),
			},
			dataSources: {
				retrieve: vi.fn().mockResolvedValue({
					properties: {
						Name: { type: "title" },
						Status: { type: "status" },
					},
				}),
				query: vi.fn().mockResolvedValue({ has_more: false, results: [] }),
			},
			pages: {
				update: vi.fn(),
				create: vi.fn().mockResolvedValue({ id: "created-page" }),
			},
		};

		const result = await withPushReservation((reservationId) => pushDatabase(app as never, client as never, "db-1", "_relay/bugs", {
			reservationId,
			onPushIntentCreating: async () => {
				phases.push("creating");
				return "intent-1";
			},
			onPushIntentCreated: async (_intentId, notionId) => {
				phases.push(`created:${notionId}`);
			},
			onPushIntentCommitted: async () => {
				phases.push("committed");
			},
		}));

		expect(result.created).toBe(1);
		expect(phases).toEqual(["creating", "created:created-page", "committed"]);
	});
});

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

function page(id: string, title: string) {
	return {
		object: "page",
		id,
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

async function withPushReservation<T>(
	task: (reservationId: string) => Promise<T>,
	databaseId = "db-1",
	vaultFolder = "_relay/bugs"
): Promise<T> {
	const manager = new ReservationManager();
	const reservation = await manager.acquire({
		entryId: "test-push",
		entryName: "Push helper test",
		databaseId,
		vaultFolder,
		type: "push",
		policy: "manual",
	});
	try {
		return await task(reservation.id);
	} finally {
		reservation.release();
	}
}
