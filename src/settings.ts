import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import NotionFreezePlugin from "./main";
import { SyncedDatabase } from "./types";
import {
	addDatabase,
	createDatabaseEntry,
	removeDatabase,
	updateDatabase,
} from "./settings-data";

export class NotionFreezeSettingTab extends PluginSettingTab {
	plugin: NotionFreezePlugin;
	private editingId: string | null = null;
	private draft: SyncedDatabase | null = null;
	private registeredRefresh = false;

	constructor(app: App, plugin: NotionFreezePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		if (!this.registeredRefresh) {
			this.plugin.registerEvent(
				(this.app.workspace as any).on("stonerelay:settings-updated", () => this.display())
			);
			this.registeredRefresh = true;
		}

		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Notion API key")
			.setDesc(
				"Create an integration at notion.so/profile/integrations and paste the key here."
			)
			.addText((text) =>
				text
					.setPlaceholder("Paste your integration token")
					.setValue(this.plugin.settings.apiKey)
					.then((t) => {
						t.inputEl.type = "password";
						t.inputEl.addClass("notion-sync-input-wide");
					})
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default output folder")
			.setDesc("Where synced Notion content will be saved by default.")
			.addText((text) =>
				text
					.setPlaceholder("Notion")
					.setValue(this.plugin.settings.defaultOutputFolder)
					.onChange(async (value) => {
						this.plugin.settings.defaultOutputFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "Synced databases" });

		if (this.plugin.settings.databases.length === 0 && !this.draft) {
			containerEl.createEl("p", {
				text: "No databases configured. Click \"Add database\" to start.",
			});
		}

		for (const entry of this.plugin.settings.databases) {
			if (this.editingId === entry.id && this.draft) {
				this.renderEditRow(containerEl, this.draft);
			} else {
				this.renderDatabaseRow(containerEl, entry);
			}
		}

		if (this.editingId === "__new__" && this.draft) {
			this.renderEditRow(containerEl, this.draft);
		}

		new Setting(containerEl)
			.addButton((btn) =>
				btn
					.setButtonText("Add database")
					.onClick(() => {
						this.editingId = "__new__";
						this.draft = {
							id: crypto.randomUUID(),
							name: "",
							databaseId: "",
							outputFolder: "",
							enabled: true,
							lastSyncedAt: null,
							lastSyncStatus: "never",
						};
						this.display();
					})
			)
			.addButton((btn) => {
				btn
					.setButtonText("Sync all enabled")
					.setCta()
					.onClick(() => {
						void this.plugin.syncAllEnabledDatabases();
					});
				if (!this.plugin.settings.databases.some((entry) => entry.enabled)) {
					btn.buttonEl.hide();
				}
			});
	}

	private renderDatabaseRow(containerEl: HTMLElement, entry: SyncedDatabase): void {
		const desc = document.createDocumentFragment();
		desc.append(document.createTextNode(`${entry.databaseId}  ·  ${entry.outputFolder || "Default folder"}  ·  `));
		desc.appendChild(formatLastSync(entry));

		new Setting(containerEl)
			.setName(entry.name)
			.setDesc(desc)
			.addToggle((toggle) =>
				toggle
					.setValue(entry.enabled)
					.onChange(async (value) => {
						this.plugin.settings = updateDatabase(this.plugin.settings, {
							...entry,
							enabled: value,
						});
						await this.plugin.saveSettings();
						this.display();
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText("Edit")
					.onClick(() => {
						this.editingId = entry.id;
						this.draft = { ...entry };
						this.display();
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText("Delete")
					.onClick(() => {
						new ConfirmRemoveModal(this.app, entry.name, async () => {
							this.plugin.settings = removeDatabase(this.plugin.settings, entry.id);
							await this.plugin.saveSettings();
							this.editingId = null;
							this.draft = null;
							this.display();
						}).open();
					})
			);
	}

	private renderEditRow(containerEl: HTMLElement, draft: SyncedDatabase): void {
		const wrapper = containerEl.createDiv({ cls: "stonerelay-database-edit" });

		new Setting(wrapper)
			.setName("Name")
			.addText((text) =>
				text
					.setPlaceholder("Sessions Mirror")
					.setValue(draft.name)
					.onChange((value) => {
						draft.name = value;
					})
			);

		new Setting(wrapper)
			.setName("Database ID")
			.addText((text) =>
				text
					.setPlaceholder("5123456789ab4def8123456789abcdef")
					.setValue(draft.databaseId)
					.then((t) => t.inputEl.addClass("notion-sync-input-wide"))
					.onChange((value) => {
						draft.databaseId = value.trim();
					})
			);

		new Setting(wrapper)
			.setName("Output folder")
			.addText((text) =>
				text
					.setPlaceholder(this.plugin.settings.defaultOutputFolder || "_relay")
					.setValue(draft.outputFolder)
					.onChange((value) => {
						draft.outputFolder = value.trim();
					})
			);

		new Setting(wrapper)
			.setName("Enabled")
			.addToggle((toggle) =>
				toggle
					.setValue(draft.enabled)
					.onChange((value) => {
						draft.enabled = value;
					})
			);

		new Setting(wrapper)
			.addButton((btn) =>
				btn
					.setButtonText("Save")
					.setCta()
					.onClick(async () => {
						try {
							const entry = createDatabaseEntry(draft);
							this.plugin.settings = this.editingId === "__new__"
								? addDatabase(this.plugin.settings, entry)
								: updateDatabase(this.plugin.settings, entry);
							await this.plugin.saveSettings();
							this.editingId = null;
							this.draft = null;
							this.display();
						} catch (err) {
							new Notice(err instanceof Error ? err.message : String(err));
						}
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText("Cancel")
					.onClick(() => {
						this.editingId = null;
						this.draft = null;
						this.display();
					})
			);
	}
}

class ConfirmRemoveModal extends Modal {
	private name: string;
	private onConfirm: () => void;

	constructor(app: App, name: string, onConfirm: () => void) {
		super(app);
		this.name = name;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		this.contentEl.createEl("h2", {
			text: `Remove "${this.name}" from sync list?`,
		});

		new Setting(this.contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Cancel")
					.onClick(() => this.close())
			)
			.addButton((btn) =>
				btn
					.setButtonText("Remove")
					.setWarning()
					.onClick(() => {
						this.close();
						this.onConfirm();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function formatLastSync(entry: SyncedDatabase): HTMLElement {
	const el = document.createElement("span");
	if (entry.lastSyncStatus === "error") {
		el.setText(`Error: ${truncate(entry.lastSyncError || "Sync failed")}`);
		el.addClass("stonerelay-sync-error");
		return el;
	}

	if (!entry.lastSyncedAt) {
		el.setText("Never synced");
		return el;
	}

	el.setText(relativeTime(entry.lastSyncedAt));
	el.title = entry.lastSyncedAt;
	return el;
}

function relativeTime(iso: string): string {
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return iso;

	const diffMs = Date.now() - then;
	const absMs = Math.abs(diffMs);
	const minutes = Math.round(absMs / 60000);
	const hours = Math.round(absMs / 3600000);
	const days = Math.round(absMs / 86400000);

	if (minutes < 1) return "Just now";
	if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
	if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
	if (days === 1) return "Yesterday";
	return `${days} days ago`;
}

function truncate(value: string): string {
	return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}
