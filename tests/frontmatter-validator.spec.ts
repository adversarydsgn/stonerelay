import { describe, expect, it, vi } from "vitest";
import { TFile, TFolder } from "obsidian";
import { buildDiagnosticsRows, renderDiagnosticsPanel } from "../src/diagnostics-panel";
import { buildFileContent } from "../src/page-writer";
import {
	buildPageProperties,
	frontmatterValueToNotionPayload,
	parseFrontmatter,
	pushDatabase,
} from "../src/push";
import { validateFrontmatter } from "../src/frontmatter-validator";
import { createTestReservationContext } from "./test-reservation-context";
import type { NotionFreezeSettings, SyncedDatabase } from "../src/types";

const dbId = "0123456789abcdef0123456789abcdef";

describe("parseFrontmatter — obsidian.parseYaml-backed", () => {
	it("parses valid mappings for supported Notion property types", () => {
		const parsed = parseFrontmatter([
			"---",
			"Name: Valid row",
			"Notes: Long note",
			"Score: 12",
			"Type: Bug",
			"Tags:",
			"  - UX",
			"  - API",
			"Status: Done",
			"Due: 2026-04-29",
			"Done: true",
			"URL: https://example.com",
			"Email: ops@example.com",
			"Phone: 555-0100",
			"Related: Existing Relation",
			"---",
			"# Body",
		].join("\n"));

		expect(parsed.parseError).toBeUndefined();
		expect(parsed.props).toMatchObject({
			Name: "Valid row",
			Notes: "Long note",
			Score: 12,
			Type: "Bug",
			Tags: ["UX", "API"],
			Status: "Done",
			Done: true,
		});
	});

	it("returns parseError.kind=yaml_syntax on malformed YAML", () => {
		expect(parseFrontmatter("---\nName: \"unterminated\n---\n# Body").parseError).toMatchObject({
			kind: "yaml_syntax",
		});
		expect(parseFrontmatter("---\nName:\n  Bad: indentation\n---\n# Body").parseError).toMatchObject({
			kind: "yaml_syntax",
		});
	});

	it("returns parseError.kind=non_object_root for scalar or sequence roots", () => {
		expect(parseFrontmatter("---\nfoo\n---\n# Body").parseError).toMatchObject({
			kind: "non_object_root",
		});
		expect(parseFrontmatter("---\n- a\n- b\n---\n# Body").parseError).toMatchObject({
			kind: "non_object_root",
		});
	});

	it("handles no frontmatter, inline empty lists, bare keys, CRLF, quoted keys, and T7 multiline strings", () => {
		expect(parseFrontmatter("").props).toEqual({});
		expect(parseFrontmatter("---\r\nTags: []\r\nEmpty:\r\n\"Next Action\": \"Line one.\\nLine two.\"\r\n---\r\nBody")).toMatchObject({
			props: {
				Tags: [],
				Empty: null,
				"Next Action": "Line one.\nLine two.",
			},
			body: "Body",
		});
	});
});

describe("validateFrontmatter", () => {
	const schema = {
		Name: { type: "title" },
		Score: { type: "number" },
		Formula: { type: "formula" },
	};

	it("keeps default mode warnings pushable", () => {
		const unknown = validateFrontmatter(doc({ Mystery: "x" }), schema, { strict: false, titleProp: "Name" });
		const invalid = validateFrontmatter(doc({ Score: "not-a-number" }), schema, { strict: false, titleProp: "Name" });
		const unsupported = validateFrontmatter(doc({ Formula: "x" }), schema, { strict: false, titleProp: "Name" });

		expect(unknown).toMatchObject({ pushable: true, issues: [{ severity: "warning", code: "unknown_property" }] });
		expect(invalid).toMatchObject({ pushable: true, issues: [{ severity: "warning", code: "invalid_value" }] });
		expect(unsupported).toMatchObject({ pushable: true, issues: [{ severity: "warning", code: "unsupported_type" }] });
	});

	it("quarantines parse errors and empty titles in both modes", () => {
		const syntax = validateFrontmatter(doc({}, {
			title: "Row",
			parseError: { kind: "yaml_syntax", message: "bad yaml" },
		}), schema, { strict: false, titleProp: "Name" });
		const emptyTitle = validateFrontmatter(doc({}, { title: "" }), schema, { strict: true, titleProp: "Name" });

		expect(syntax).toMatchObject({ pushable: false, issues: [{ severity: "error", code: "yaml_syntax" }] });
		expect(emptyTitle).toMatchObject({ pushable: false, issues: [{ severity: "error", code: "required_missing" }] });
	});

	it("turns unknown and invalid values into errors in strict mode", () => {
		expect(validateFrontmatter(doc({ Mystery: "x" }), schema, { strict: true, titleProp: "Name" })).toMatchObject({
			pushable: false,
			issues: [{ severity: "error", code: "unknown_property" }],
		});
		expect(validateFrontmatter(doc({ Score: "not-a-number" }), schema, { strict: true, titleProp: "Name" })).toMatchObject({
			pushable: false,
			issues: [{ severity: "error", code: "invalid_value" }],
		});
		expect(validateFrontmatter(doc({ Score: 10 }), schema, { strict: true, titleProp: "Name" })).toMatchObject({
			pushable: true,
			issues: [],
		});
	});
});

describe("push integration — frontmatter validation", () => {
	it("pushes a valid row with all supported mutable property payloads", async () => {
		const { result, client } = await runPush([
			markdown("valid.md", [
				"---",
				"Name: Valid row",
				"Notes: Long note",
				"Score: 12",
				"Type: Bug",
				"Tags: UX, API",
				"Status: Done",
				"Due: 2026-04-29",
				"Done: true",
				"URL: https://example.com",
				"Email: ops@example.com",
				"Phone: 555-0100",
				"Related: Existing Relation",
				"---",
				"# Valid row",
			].join("\n")),
		], { strict: true });

		expect(result).toMatchObject({ total: 1, created: 1, skipped: 0, failed: 0 });
		expect(client.pages.create).toHaveBeenCalledTimes(1);
		expect(client.pages.create.mock.calls[0][0].properties).toMatchObject({
			Name: { title: [{ type: "text", text: { content: "Valid row" } }] },
			Score: { number: 12 },
			Tags: { multi_select: [{ name: "UX" }, { name: "API" }] },
			Related: { relation: [{ id: "rel-1" }] },
		});
	});

	it("quarantines YAML syntax errors in strict and default modes before Notion mutation", async () => {
		for (const strict of [false, true]) {
			const onRowError = vi.fn();
			const { result, client } = await runPush([
				markdown("bad.md", "---\nName: \"unterminated\n---\n# Bad"),
			], { strict, onRowError });

			expect(result).toMatchObject({ total: 1, created: 0, updated: 0, skipped: 1 });
			expect(result.errors[0]).toContain("unterminated");
			expect(client.pages.create).not.toHaveBeenCalled();
			expect(client.pages.update).not.toHaveBeenCalled();
			expect(onRowError).toHaveBeenCalledWith(expect.objectContaining({
				errorCode: "schema_mismatch",
				severity: "error",
			}));
		}
	});

	it("strict mode quarantines unknown properties while default mode warns and pushes", async () => {
		const strictRun = await runPush([markdown("unknown.md", "---\nName: Row\nMystery: value\n---\n# Row")], { strict: true });
		expect(strictRun.result).toMatchObject({ created: 0, skipped: 1 });
		expect(strictRun.client.pages.create).not.toHaveBeenCalled();

		const defaultRun = await runPush([markdown("unknown.md", "---\nName: Row\nMystery: value\n---\n# Row")], { strict: false });
		expect(defaultRun.result).toMatchObject({ created: 1, skipped: 0 });
		expect(defaultRun.result.errors[0]).toContain("Mystery");
		expect(defaultRun.client.pages.create.mock.calls[0][0].properties).not.toHaveProperty("Mystery");
	});

	it("strict mode quarantines invalid values while default mode drops the field and pushes", async () => {
		const strictRun = await runPush([markdown("invalid.md", "---\nName: Row\nScore: not-a-number\n---\n# Row")], { strict: true });
		expect(strictRun.result).toMatchObject({ created: 0, skipped: 1 });

		const defaultRun = await runPush([markdown("invalid.md", "---\nName: Row\nScore: not-a-number\n---\n# Row")], { strict: false });
		expect(defaultRun.result).toMatchObject({ created: 1, skipped: 0 });
		expect(defaultRun.client.pages.create.mock.calls[0][0].properties).not.toHaveProperty("Score");
	});

	it("pushes valid files and skips invalid files in the same strict run", async () => {
		const { result, client } = await runPush([
			markdown("valid.md", "---\nName: Valid\nScore: 1\n---\n# Valid"),
			markdown("bad.md", "---\nName: \"unterminated\n---\n# Bad"),
		], { strict: true });

		expect(result).toMatchObject({ total: 2, created: 1, skipped: 1, failed: 0 });
		expect(client.pages.create).toHaveBeenCalledTimes(1);
	});
});

describe("frontmatter round-trip and diagnostics", () => {
	it("parses pull-written frontmatter and preserves T7 same-line escaped multiline values", () => {
		const content = buildFileContent({
			"notion-id": "page-1",
			Context: "Decision line one.\nDecision line two.",
			Tags: ["foo"],
		}, "# Body\n");
		const parsed = parseFrontmatter(content);

		expect(parsed.parseError).toBeUndefined();
		expect(parsed.props.Context).toBe("Decision line one.\nDecision line two.");
		expect(parsed.props.Tags).toEqual(["foo"]);
		expect(frontmatterValueToNotionPayload("multi_select", "Tags", [])).toBeUndefined();
		expect(parseFrontmatter("---\nTags:\n---\n# Body").props.Tags).toBeNull();
	});

	it("renders frontmatter validation diagnostics with errors before warnings", () => {
		const root = fakeElement("root");
		const data = settings([database({
			lastSyncErrors: [
				{
					rowId: "vault/warn.md",
					direction: "push",
					error: "Mystery: unknown",
					errorCode: "schema_mismatch",
					severity: "warning",
					property: "Mystery",
					timestamp: "2026-04-29T10:00:00.000Z",
				},
				{
					rowId: "vault/error.md",
					direction: "push",
					error: "bad yaml",
					errorCode: "schema_mismatch",
					severity: "error",
					property: null,
					timestamp: "2026-04-29T10:01:00.000Z",
				},
			],
		})]);

		renderDiagnosticsPanel(root as never, data);
		const text = flattenText(root).join("\n");

		expect(buildDiagnosticsRows(data)[0].validationIssues).toHaveLength(2);
		expect(text).toContain("Frontmatter validation");
		expect(text).toContain("vault/error.md");
		expect(text).toContain("—");
		expect(text.indexOf("vault/error.md")).toBeLessThan(text.indexOf("vault/warn.md"));
	});

	it("imports parser and validator in the runtime smoke shape", () => {
		expect(parseFrontmatter("")).toEqual({ props: {}, body: "" });
		expect(validateFrontmatter(doc({ Score: 1 }), { Name: { type: "title" }, Score: { type: "number" } }, {
			strict: true,
			titleProp: "Name",
		}).pushable).toBe(true);
	});
});

function doc(props: Record<string, unknown>, overrides: { title?: string; parseError?: never } = {}) {
	return {
		file: { path: "vault/row.md" },
		props,
		title: overrides.title ?? "Row",
		parseError: overrides.parseError,
	};
}

function markdown(name: string, content: string) {
	const path = `_relay/bugs/${name}`;
	const file = Object.assign(Object.create(TFile.prototype), {
		path,
		name,
		basename: name.replace(/\.md$/, ""),
		extension: "md",
		stat: { mtime: Date.parse("2026-04-29T10:00:00.000Z") },
	});
	return { file, content };
}

async function runPush(
	files: Array<ReturnType<typeof markdown>>,
	options: { strict: boolean; onRowError?: (...args: never[]) => void }
) {
	const folder = Object.assign(Object.create(TFolder.prototype), { path: "_relay/bugs", children: [] });
	const app = {
		vault: {
			adapter: {
				write: vi.fn(async () => undefined),
				rename: vi.fn(async () => undefined),
			},
			getAbstractFileByPath: vi.fn((path: string) => path === "_relay/bugs" ? folder : null),
			getMarkdownFiles: vi.fn(() => files.map((entry) => entry.file)),
			cachedRead: vi.fn(async (file: TFile) => files.find((entry) => entry.file === file)?.content ?? ""),
		},
	};
	const client = notionClient();
	const result = await pushDatabase(app as never, client as never, dbId, "_relay/bugs", {
		context: createTestReservationContext("frontmatter-validator") as never,
		strictFrontmatterSchema: options.strict,
		onRowError: options.onRowError as never,
	});
	return { result, client };
}

function notionClient() {
	return {
		databases: {
			retrieve: vi.fn(async () => ({
				title: [richText("Bugs")],
				data_sources: [{ id: "source-1" }],
			})),
		},
		dataSources: {
			retrieve: vi.fn(async () => ({
				properties: schema(),
			})),
			query: vi.fn(async () => ({
				object: "list",
				has_more: false,
				results: [{
					object: "page",
					id: "rel-1",
					properties: {
						Name: {
							type: "title",
							title: [richText("Existing Relation")],
						},
					},
				}],
			})),
		},
		pages: {
			create: vi.fn(async () => ({
				id: "page-new",
				url: "https://notion.so/page-new",
				last_edited_time: "2026-04-29T10:10:00.000Z",
			})),
			update: vi.fn(async () => ({
				id: "page-existing",
				url: "https://notion.so/page-existing",
				last_edited_time: "2026-04-29T10:10:00.000Z",
			})),
		},
	};
}

function schema() {
	return {
		Name: { type: "title" },
		Notes: { type: "rich_text" },
		Score: { type: "number" },
		Type: { type: "select" },
		Tags: { type: "multi_select" },
		Status: { type: "status" },
		Due: { type: "date" },
		Done: { type: "checkbox" },
		URL: { type: "url" },
		Email: { type: "email" },
		Phone: { type: "phone_number" },
		Related: { type: "relation" },
		Formula: { type: "formula" },
	};
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

function database(overrides: Partial<SyncedDatabase> = {}): SyncedDatabase {
	return {
		id: overrides.id ?? "db-1",
		name: overrides.name ?? "Bugs DB",
		databaseId: overrides.databaseId ?? dbId,
		outputFolder: overrides.outputFolder ?? "_relay",
		errorLogFolder: overrides.errorLogFolder ?? "",
		groupId: overrides.groupId ?? null,
		autoSync: overrides.autoSync ?? "inherit",
		direction: overrides.direction ?? "bidirectional",
		enabled: overrides.enabled ?? true,
		lastSyncedAt: overrides.lastSyncedAt ?? null,
		lastSyncStatus: overrides.lastSyncStatus ?? "never",
		lastSyncError: overrides.lastSyncError,
		lastPulledAt: overrides.lastPulledAt ?? null,
		lastPushedAt: overrides.lastPushedAt ?? null,
		current_phase: overrides.current_phase ?? "phase_2",
		initial_seed_direction: overrides.initial_seed_direction ?? "pull",
		source_of_truth: overrides.source_of_truth ?? "notion",
		templater_managed: overrides.templater_managed ?? false,
		first_sync_completed_at: overrides.first_sync_completed_at ?? null,
		nest_under_db_name: overrides.nest_under_db_name ?? true,
		current_sync_id: overrides.current_sync_id ?? null,
		lastCommittedRowId: overrides.lastCommittedRowId ?? null,
		lastSyncErrors: overrides.lastSyncErrors ?? [],
		strictFrontmatterSchema: overrides.strictFrontmatterSchema ?? false,
	};
}

function settings(databases: SyncedDatabase[]): NotionFreezeSettings {
	return {
		apiKey: "",
		defaultOutputFolder: "_relay",
		defaultErrorLogFolder: "",
		databases,
		pages: [],
		groups: [],
		pendingConflicts: [],
		active_reservations: [],
		autoSyncEnabled: false,
		autoSyncDatabasesByDefault: false,
		autoSyncPagesByDefault: false,
		schemaVersion: 7,
	};
}

function fakeElement(tag: string): any {
	return {
		tag,
		textContent: "",
		children: [] as any[],
		listeners: new Map<string, () => void>(),
		createDiv(options?: { cls?: string }) {
			const child = fakeElement("div");
			child.cls = options?.cls;
			this.children.push(child);
			return child;
		},
		createEl(childTag: string, options?: { text?: string; cls?: string }) {
			const child = fakeElement(childTag);
			child.textContent = options?.text ?? "";
			child.cls = options?.cls;
			this.children.push(child);
			return child;
		},
		addEventListener(event: string, callback: () => void) {
			this.listeners.set(event, callback);
		},
	};
}

function flattenText(element: any): string[] {
	return [
		element.textContent,
		...element.children.flatMap((child: any) => flattenText(child)),
	].filter(Boolean);
}
