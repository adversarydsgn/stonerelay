import { afterEach, describe, expect, it, vi } from "vitest";
import { Setting } from "obsidian";
import NotionFreezePlugin from "../src/main";
import { NotionFreezeSettingTab } from "../src/settings";
import { migrateData } from "../src/settings-data";
import type { SyncedDatabase } from "../src/types";

describe("settings UI templater toggle", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("disables source of truth while preserving the stored source value", () => {
		vi.stubGlobal("document", documentMock());
		const toggles: ToggleComponent[] = [];
		const dropdowns: DropdownComponent[] = [];
		vi.spyOn(Setting.prototype, "addToggle").mockImplementation(function (callback) {
			const component = toggleComponent();
			toggles.push(component);
			callback(component);
			return this;
		});
		vi.spyOn(Setting.prototype, "addDropdown").mockImplementation(function (callback) {
			const component = dropdownComponent();
			dropdowns.push(component);
			callback(component);
			return this;
		});

		const plugin = new NotionFreezePlugin();
		plugin.app = appMock() as never;
		plugin.settings = migrateData(null);
		const tab = new NotionFreezeSettingTab(plugin.app, plugin);
		const draft = databaseDraft();
		(tab as unknown as { editingId: string | null }).editingId = "db-1";
		(tab as unknown as { draft: SyncedDatabase | null }).draft = draft;
		vi.spyOn(tab, "display").mockImplementation(() => undefined);

		render(tab, draft);
		let sourceDropdown = dropdowns.find((dropdown) => dropdown.options.has("manual_merge"));
		expect(sourceDropdown?.disabled).toBe(false);
		expect(sourceDropdown?.value).toBe("obsidian");

		toggles[0].onChangeCallback?.(true);
		expect(draft.templater_managed).toBe(true);
		expect(draft.source_of_truth).toBe("obsidian");

		toggles.length = 0;
		dropdowns.length = 0;
		const enabledRoot = render(tab, draft);
		sourceDropdown = dropdowns.find((dropdown) => dropdown.options.has("manual_merge"));
		expect(sourceDropdown?.disabled).toBe(true);
		expect(flattenText(enabledRoot)).toContain("Overridden — this folder halts on all vault changes.");

		toggles[0].onChangeCallback?.(false);
		expect(draft.templater_managed).toBe(false);
		expect(draft.source_of_truth).toBe("obsidian");

		toggles.length = 0;
		dropdowns.length = 0;
		const disabledRoot = render(tab, draft);
		sourceDropdown = dropdowns.find((dropdown) => dropdown.options.has("manual_merge"));
		expect(sourceDropdown?.disabled).toBe(false);
		expect(flattenText(disabledRoot)).not.toContain("Overridden — this folder halts on all vault changes.");
	});
});

interface ToggleComponent {
	value: boolean;
	onChangeCallback?: (value: boolean) => void;
	setValue(value: boolean): ToggleComponent;
	onChange(callback: (value: boolean) => void): ToggleComponent;
}

interface DropdownComponent {
	value: string;
	disabled: boolean;
	options: Map<string, string>;
	onChangeCallback?: (value: string) => void;
	addOption(value: string, label: string): DropdownComponent;
	setValue(value: string): DropdownComponent;
	setDisabled(value: boolean): DropdownComponent;
	onChange(callback: (value: string) => void): DropdownComponent;
}

function toggleComponent(): ToggleComponent {
	const component: ToggleComponent = {
		value: false,
		setValue(value) {
			component.value = value;
			return component;
		},
		onChange(callback) {
			component.onChangeCallback = callback;
			return component;
		},
	};
	return component;
}

function dropdownComponent(): DropdownComponent {
	const component: DropdownComponent = {
		value: "",
		disabled: false,
		options: new Map(),
		addOption(value, label) {
			component.options.set(value, label);
			return component;
		},
		setValue(value) {
			component.value = value;
			return component;
		},
		setDisabled(value) {
			component.disabled = value;
			return component;
		},
		onChange(callback) {
			component.onChangeCallback = callback;
			return component;
		},
	};
	return component;
}

function render(tab: NotionFreezeSettingTab, draft: SyncedDatabase): TestElement {
	const root = createTestElement("root");
	(tab as unknown as { renderEditRow(container: HTMLElement, draft: SyncedDatabase): void })
		.renderEditRow(root as never, draft);
	return root;
}

function databaseDraft(): SyncedDatabase {
	return {
		id: "db-1",
		name: "Bugs",
		databaseId: "0123456789abcdef0123456789abcdef",
		outputFolder: "_relay/bugs",
		errorLogFolder: "",
		groupId: null,
		autoSync: "inherit",
		direction: "bidirectional",
		enabled: true,
		lastSyncedAt: "2026-04-29T10:00:00.000Z",
		lastSyncStatus: "ok",
		lastPulledAt: "2026-04-29T10:00:00.000Z",
		lastPushedAt: null,
		current_phase: "phase_2",
		initial_seed_direction: "pull",
		source_of_truth: "obsidian",
		templater_managed: false,
		first_sync_completed_at: "2026-04-29T10:00:00.000Z",
		nest_under_db_name: true,
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

interface TestElement {
	tag: string;
	textContent: string;
	children: TestElement[];
	listeners: Map<string, (...args: never[]) => void>;
	cls?: string;
	disabled?: boolean;
	type?: string;
	title?: string;
	ariaPressed?: string;
	empty(): void;
	createDiv(options?: { cls?: string; text?: string }): TestElement;
	createEl(tag: string, options?: { text?: string | object; cls?: string }): TestElement;
	createSpan(options?: { text?: string; cls?: string }): TestElement;
	addEventListener(event: string, callback: (...args: never[]) => void): void;
	onClickEvent(callback: (...args: never[]) => void): void;
	append(...nodes: TestElement[]): void;
	appendChild(node: TestElement): void;
	addClass(..._classes: string[]): void;
	removeClass(..._classes: string[]): void;
	setText(text: string): void;
}

function createTestElement(tag: string): TestElement {
	return {
		tag,
		textContent: "",
		children: [],
		listeners: new Map(),
		empty() {
			this.children = [];
			this.textContent = "";
		},
		createDiv(options) {
			const child = createTestElement("div");
			child.cls = options?.cls;
			child.textContent = options?.text ?? "";
			this.children.push(child);
			return child;
		},
		createEl(childTag, options) {
			const child = createTestElement(childTag);
			child.textContent = typeof options?.text === "string" ? options.text : "";
			child.cls = options?.cls;
			this.children.push(child);
			return child;
		},
		createSpan(options) {
			const child = createTestElement("span");
			child.textContent = options?.text ?? "";
			child.cls = options?.cls;
			this.children.push(child);
			return child;
		},
		addEventListener(event, callback) {
			this.listeners.set(event, callback);
		},
		onClickEvent(callback) {
			this.listeners.set("click", callback);
		},
		append(...nodes) {
			this.children.push(...nodes);
		},
		appendChild(node) {
			this.children.push(node);
		},
		addClass: () => undefined,
		removeClass: () => undefined,
		setText(text) {
			this.textContent = text;
		},
	};
}

function documentMock() {
	return {
		createDocumentFragment: () => createTestElement("fragment"),
		createTextNode: (text: string) => ({ ...createTestElement("#text"), textContent: text }),
		createElement: (tag: string) => createTestElement(tag),
		createElementNS: (_namespace: string, tag: string) => createTestElement(tag),
	};
}

function flattenText(element: TestElement): string[] {
	return [
		element.textContent,
		...element.children.flatMap((child) => flattenText(child)),
	].filter(Boolean);
}
