import { describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import NotionFreezePlugin from "../src/main";
import { NotionFreezeSettingTab } from "../src/settings";
import { migrateData } from "../src/settings-data";

describe("settings Test connection runtime", () => {
	it("uses the Obsidian-bound Notion client without a dynamic obsidian import", async () => {
		vi.stubGlobal("document", documentMock());
		const requestUrl = vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
			status: 200,
			headers: { "content-type": "application/json" },
			arrayBuffer: new TextEncoder().encode(JSON.stringify({
				object: "database",
				title: [{ type: "text", plain_text: "Runtime DB", text: { content: "Runtime DB" } }],
				data_sources: [{ id: "source-1" }],
			})).buffer,
		} as never);
		requestUrl
			.mockResolvedValueOnce(jsonResponse({
				object: "database",
				title: [{ type: "text", plain_text: "Runtime DB", text: { content: "Runtime DB" } }],
				data_sources: [{ id: "source-1" }],
			}))
			.mockResolvedValueOnce(jsonResponse({
				object: "data_source",
				properties: { Name: { type: "title" } },
			}))
			.mockResolvedValueOnce(jsonResponse({
				object: "list",
				has_more: false,
				results: [],
			}));
		const plugin = new NotionFreezePlugin();
		plugin.app = appMock() as never;
		plugin.settings = {
			...migrateData(null),
			apiKey: "ntn_test",
		};
		plugin.manifest = { id: "stonerelay", version: "0.9.10" } as never;
		const tab = new NotionFreezeSettingTab(plugin.app, plugin);
		(tab as unknown as { editingId: string | null }).editingId = "__new__";
		const draft = databaseDraft();
		(tab as unknown as { draft: ReturnType<typeof databaseDraft> | null }).draft = draft;
		const root = createTestElement("root");

		(tab as unknown as { renderEditRow: (container: HTMLElement, draft: ReturnType<typeof databaseDraft>) => void })
			.renderEditRow(root as never, draft);
		clickButton(root, "Test connection");
		await waitForAsyncWork();
		expect(requestUrl).toHaveBeenCalledTimes(3);
		expect(flattenText(root).join("\n")).toContain("Connected to \"Runtime DB\"");
	});
});

function jsonResponse(body: unknown): never {
	return {
		status: 200,
		headers: { "content-type": "application/json" },
		arrayBuffer: new TextEncoder().encode(JSON.stringify(body)).buffer,
	} as never;
}

function databaseDraft() {
	return {
		id: "db-1",
		name: "",
		databaseId: "0123456789abcdef0123456789abcdef",
		outputFolder: "_relay/runtime",
		errorLogFolder: "",
		groupId: null,
		autoSync: "inherit" as const,
		direction: "pull" as const,
		enabled: true,
		lastSyncedAt: null,
		lastSyncStatus: "never" as const,
		lastPulledAt: null,
		lastPushedAt: null,
		current_phase: "phase_1" as const,
		initial_seed_direction: null,
		source_of_truth: null,
		first_sync_completed_at: null,
		nest_under_db_name: true,
		templater_managed: false,
		current_sync_id: null,
		lastCommittedRowId: null,
		lastSyncErrors: [],
	};
}

function appMock() {
	return {
		vault: {
			getAbstractFileByPath: vi.fn(() => null),
			getMarkdownFiles: vi.fn(() => []),
		},
		metadataCache: {
			getFileCache: vi.fn(() => ({ frontmatter: {} })),
		},
		workspace: {
			on: vi.fn(() => ({})),
			trigger: vi.fn(),
		},
	};
}

function createTestElement(tag: string): any {
	return {
		tag,
		textContent: "",
		children: [] as any[],
		listeners: new Map<string, () => void>(),
		empty() {
			this.children = [];
			this.textContent = "";
		},
		createDiv(options?: { cls?: string }) {
			const child = createTestElement("div");
			child.cls = options?.cls;
			this.children.push(child);
			return child;
		},
		createEl(childTag: string, options?: { text?: string; cls?: string }) {
			const child = createTestElement(childTag);
			child.textContent = options?.text ?? "";
			child.cls = options?.cls;
			this.children.push(child);
			return child;
		},
		createSpan(options?: { text?: string; cls?: string }) {
			const child = createTestElement("span");
			child.textContent = options?.text ?? "";
			child.cls = options?.cls;
			this.children.push(child);
			return child;
		},
		addEventListener(event: string, callback: () => void) {
			this.listeners.set(event, callback);
		},
		onClickEvent(callback: () => void) {
			this.listeners.set("click", callback);
		},
		append(...nodes: any[]) {
			this.children.push(...nodes);
		},
		appendChild(node: any) {
			this.children.push(node);
		},
		addClass: () => undefined,
		removeClass: () => undefined,
		setText(text: string) {
			this.textContent = text;
		},
	};
}

function documentMock() {
	return {
		createDocumentFragment: () => createTestElement("fragment"),
		createTextNode: (text: string) => ({ tag: "#text", textContent: text, children: [] }),
		createElement: (tag: string) => createTestElement(tag),
	};
}

function waitForAsyncWork(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function clickButton(element: any, text: string): void {
	if (element.tag === "button" && element.textContent === text) {
		element.listeners.get("click")?.();
		return;
	}
	for (const child of element.children) clickButton(child, text);
}

function flattenText(element: any): string[] {
	return [
		element.textContent,
		...element.children.flatMap((child: any) => flattenText(child)),
	].filter(Boolean);
}
