import { addIcon, App, Notice, Plugin, SuggestModal } from "obsidian";
import { NotionFreezeSettings, DatabaseSyncResult, SyncedDatabase } from "./types";
import { NotionFreezeSettingTab } from "./settings";
import { FreezeModal, FrozenDatabase } from "./freeze-modal";
import { createNotionClient, normalizeNotionId } from "./notion-client";
import { freshDatabaseImport, refreshDatabase } from "./database-freezer";
import { migrateData, resolveOutputFolder, syncAll, updateDatabase } from "./settings-data";

export default class NotionFreezePlugin extends Plugin {
	settings: NotionFreezeSettings = migrateData(null);

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new NotionFreezeSettingTab(this.app, this));

		addIcon(
			"notion-db-sync",
			`<path d="M54 8 A44 44 0 0 1 92 52" stroke="currentColor" stroke-width="5" fill="none" stroke-linecap="round"/>` +
			`<path fill="currentColor" d="M96 46 92 58 84 48Z"/>` +
			`<path d="M46 92 A44 44 0 0 1 8 48" stroke="currentColor" stroke-width="5" fill="none" stroke-linecap="round"/>` +
			`<path fill="currentColor" d="M4 54 8 42 16 52Z"/>` +
			`<path fill="currentColor" d="M34 28v44h8V42l16 30h8V28h-8v30L42 28Z"/>`
		);
		this.addRibbonIcon("notion-db-sync", "Sync Notion database", () => {
			this.openFreezeModal();
		});

		this.addCommand({
			id: "sync-notion",
			name: "Sync Notion database",
			callback: () => this.openFreezeModal(),
		});

		this.addCommand({
			id: "stonerelay:sync-all",
			name: "Stonerelay: Sync all enabled databases",
			callback: () => { void this.syncAllEnabledDatabases(); },
		});

		this.addCommand({
			id: "stonerelay:sync-database",
			name: "Stonerelay: Sync one database",
			callback: () => this.openConfiguredDatabasePicker(),
		});
	}

	async loadSettings(): Promise<void> {
		const raw = await this.loadData();
		this.settings = migrateData(raw);
		if (!raw?.schemaVersion || raw.schemaVersion < 2) {
			await this.saveSettings();
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private openFreezeModal(): void {
		if (!this.settings.apiKey) {
			new Notice(
				"Notion API key not set. Configure in plugin settings."
			);
			return;
		}

		new FreezeModal(
			this.app,
			this.settings.defaultOutputFolder,
			(result) => { void this.executeFreshImport(result.notionInput, result.outputFolder); },
			(db) => { void this.executeRefresh(db); }
		).open();
	}

	async syncAllEnabledDatabases(): Promise<void> {
		const result = await syncAll(
			this.settings,
			async (entry, outputFolder) => {
				await this.syncConfiguredDatabase(entry, outputFolder);
			},
			(message) => new Notice(message)
		);
		this.settings = result.settings;
		await this.saveSettings();
		(this.app.workspace as any).trigger("stonerelay:settings-updated");
	}

	private openConfiguredDatabasePicker(): void {
		if (this.settings.databases.length === 0) {
			this.openFreezeModal();
			return;
		}

		new DatabasePickerModal(this.app, this.settings.databases, (entry) => {
			void this.syncOneConfiguredDatabase(entry);
		}).open();
	}

	private async syncOneConfiguredDatabase(entry: SyncedDatabase): Promise<void> {
		try {
			new Notice(`Syncing ${entry.name}...`);
			await this.syncConfiguredDatabase(entry, resolveOutputFolder(this.settings, entry));
			this.settings = updateDatabase(this.settings, {
				...entry,
				lastSyncedAt: new Date().toISOString(),
				lastSyncStatus: "ok",
				lastSyncError: undefined,
			});
			await this.saveSettings();
			(this.app.workspace as any).trigger("stonerelay:settings-updated");
			new Notice(`Sync complete: ${entry.name}`);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.settings = updateDatabase(this.settings, {
				...entry,
				lastSyncStatus: "error",
				lastSyncError: message.slice(0, 200),
			});
			await this.saveSettings();
			(this.app.workspace as any).trigger("stonerelay:settings-updated");
			console.error("Notion sync error:", err);
			new Notice(`Notion sync error: ${message}`);
		}
	}

	async syncConfiguredDatabase(
		entry: SyncedDatabase,
		outputFolder: string
	): Promise<DatabaseSyncResult> {
		return this.syncDatabase(entry.databaseId, outputFolder);
	}

	private async executeFreshImport(
		input: string,
		outputFolder: string
	): Promise<void> {
		try {
			const databaseId = normalizeNotionId(input);
			const result = await this.syncDatabase(databaseId, outputFolder);
			new Notice(formatDatabaseResult(result.title, result, "imported"));
		} catch (err) {
			console.error("Notion sync error:", err);
			new Notice(
				`Notion sync error: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	private async executeRefresh(db: FrozenDatabase): Promise<void> {
		try {
			const result = await this.refreshFrozenDatabase(db);
			new Notice(formatDatabaseResult(result.title, result, "re-synced"));
		} catch (err) {
			console.error("Notion sync error:", err);
			new Notice(
				`Notion sync error: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	private async syncDatabase(
		databaseId: string,
		outputFolder: string
	): Promise<DatabaseSyncResult> {
		if (!this.settings.apiKey) {
			new Notice("Notion API key not set. Configure in plugin settings.");
			throw new Error("Notion API key not set.");
		}

		const normalizedId = normalizeNotionId(databaseId);
		const existing = this.findFrozenDatabase(normalizedId);
		if (existing) {
			return this.refreshFrozenDatabase(existing);
		}

		const client = createNotionClient(this.settings.apiKey);
		const notice = new Notice("Querying database from Notion...", 0);
		try {
			const result = await freshDatabaseImport(
				this.app,
				client,
				normalizedId,
				outputFolder,
				(progress) => {
					switch (progress.phase) {
						case "querying":
							notice.setMessage("Querying database from Notion...");
							break;
						case "importing":
							notice.setMessage(
								`Importing ${progress.current} / ${progress.total} entries...`
							);
							break;
						case "done":
							notice.hide();
							break;
					}
				}
			);
			notice.hide();
			return result;
		} catch (err) {
			notice.hide();
			throw err;
		}
	}

	private async refreshFrozenDatabase(db: FrozenDatabase): Promise<DatabaseSyncResult> {
		if (!this.settings.apiKey) {
			new Notice("Notion API key not set. Configure in plugin settings.");
			throw new Error("Notion API key not set.");
		}

		const client = createNotionClient(this.settings.apiKey);
		const notice = new Notice(`Querying "${db.title}" from Notion...`, 0);
		try {
			const result = await refreshDatabase(
				this.app,
				client,
				db,
				(progress) => {
					switch (progress.phase) {
						case "querying":
							notice.setMessage(`Querying "${db.title}" from Notion...`);
							break;
						case "diffing":
							notice.setMessage("Checking against current freeze dates...");
							break;
						case "detected":
							new Notice(
								`Detected ${progress.staleCount} of ${progress.total} entries out of date`,
								5000
							);
							break;
						case "importing":
							notice.setMessage(
								`Refreshing ${progress.current} / ${progress.total} entries...`
							);
							break;
						case "done":
							notice.hide();
							break;
					}
				}
			);
			notice.hide();
			return result;
		} catch (err) {
			notice.hide();
			throw err;
		}
	}

	private findFrozenDatabase(databaseId: string): FrozenDatabase | null {
		const dbMap = new Map<string, FrozenDatabase>();

		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			const dbId = cache?.frontmatter?.["notion-database-id"];
			if (!dbId) continue;

			const existing = dbMap.get(dbId);
			if (existing) {
				existing.entryCount++;
			} else {
				const folderPath = file.parent?.path || "";
				dbMap.set(dbId, {
					databaseId: dbId,
					title: folderName(folderPath),
					folderPath,
					entryCount: 1,
				});
			}
		}

		return dbMap.get(databaseId) ?? null;
	}
}

class DatabasePickerModal extends SuggestModal<SyncedDatabase> {
	private databases: SyncedDatabase[];
	private onChoose: (entry: SyncedDatabase) => void;

	constructor(
		app: App,
		databases: SyncedDatabase[],
		onChoose: (entry: SyncedDatabase) => void
	) {
		super(app);
		this.databases = databases;
		this.onChoose = onChoose;
		this.setPlaceholder("Choose a Stonerelay database to sync");
	}

	getSuggestions(query: string): SyncedDatabase[] {
		const lowerQuery = query.toLowerCase();
		return this.databases.filter((entry) =>
			entry.name.toLowerCase().includes(lowerQuery) ||
			entry.databaseId.toLowerCase().includes(lowerQuery) ||
			entry.outputFolder.toLowerCase().includes(lowerQuery)
		);
	}

	renderSuggestion(entry: SyncedDatabase, el: HTMLElement): void {
		el.createEl("div", { text: entry.name });
		el.createEl("small", {
			text: `${entry.enabled ? "Enabled" : "Disabled"} · ${entry.outputFolder || "Default folder"}`,
		});
	}

	onChooseSuggestion(entry: SyncedDatabase): void {
		this.onChoose(entry);
	}
}

function formatDatabaseResult(
	title: string,
	result: DatabaseSyncResult,
	verb: string
): string {
	let msg =
		`Notion sync: "${title}" ${verb}. ` +
		`${result.created} created, ${result.updated} updated, ` +
		`${result.skipped} unchanged, ${result.deleted} deleted`;
	if (result.failed > 0) {
		msg += `, ${result.failed} failed`;
	}
	msg += ".";
	if (result.errors.length > 0) {
		msg += "\nErrors:\n" + result.errors.join("\n");
	}
	return msg;
}

function folderName(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx >= 0 ? path.slice(idx + 1) : path || "Untitled";
}
