import { addIcon, App, Notice, Plugin, SuggestModal } from "obsidian";
import { Conflict, NotionFreezeSettings, DatabaseSyncResult, SyncError, SyncRunOptions, SyncRunType, SyncedDatabase } from "./types";
import { NotionFreezeSettingTab } from "./settings";
import { FreezeModal, FrozenDatabase } from "./freeze-modal";
import { createNotionClient, normalizeNotionId } from "./notion-client";
import { freshDatabaseImport, refreshDatabase } from "./database-freezer";
import { migrateData, resolveOutputFolder, syncAll, updateDatabase } from "./settings-data";
import { pushDatabase } from "./push";
import { applyPhaseTransition, syncErrorsFromMessages, SyncCancelled } from "./sync-state";
import { PluginDataAdapter, writePluginDataAtomic } from "./plugin-data";

export default class NotionFreezePlugin extends Plugin {
	settings: NotionFreezeSettings = migrateData(null);
	private syncControllers = new Map<string, AbortController>();
	private cancellingAll = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		await this.markInterruptedSyncs();
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

		this.addCommand({
			id: "stonerelay:push-all",
			name: "Stonerelay: Push all enabled databases (push or bidirectional)",
			callback: () => { void this.pushAllEnabledDatabases(); },
		});

		this.addCommand({
			id: "stonerelay:push-database",
			name: "Stonerelay: Push one database",
			callback: () => this.openConfiguredDatabasePicker("push"),
		});
	}

	async loadSettings(): Promise<void> {
		const raw = await this.loadData();
		this.settings = migrateData(raw);
		if (!raw?.schemaVersion || raw.schemaVersion < 4) {
			await this.saveSettings();
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveSettingsAtomic(this.settings);
	}

	isSyncActive(entryId: string): boolean {
		return this.syncControllers.has(entryId);
	}

	isCancellingAll(): boolean {
		return this.cancellingAll;
	}

	hasActiveSyncs(): boolean {
		return this.syncControllers.size > 0;
	}

	cancelSync(entryId: string): void {
		const controller = this.syncControllers.get(entryId);
		if (!controller) return;
		controller.abort();
		new Notice("Cancelling sync. Finishing this row first.");
		(this.app.workspace as any).trigger("stonerelay:settings-updated");
	}

	cancelAllSyncs(): void {
		if (this.syncControllers.size === 0) return;
		this.cancellingAll = true;
		for (const controller of this.syncControllers.values()) {
			controller.abort();
		}
		if (this.syncControllers.size > 0) {
			new Notice("Cancelling syncs. Finishing active rows first.");
		}
		(this.app.workspace as any).trigger("stonerelay:settings-updated");
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
				return this.syncConfiguredDatabase(entry, outputFolder);
			},
			(message) => new Notice(message)
		);
		this.settings = result.settings;
		await this.saveSettings();
		(this.app.workspace as any).trigger("stonerelay:settings-updated");
	}

	async pushAllEnabledDatabases(): Promise<void> {
		const result = await syncAll(
			this.settings,
			async (entry, outputFolder) => {
				return this.pushConfiguredDatabase(entry, outputFolder);
			},
			(message) => new Notice(message),
			"push"
		);
		this.settings = result.settings;
		await this.saveSettings();
		(this.app.workspace as any).trigger("stonerelay:settings-updated");
	}

	private openConfiguredDatabasePicker(mode: "pull" | "push" = "pull"): void {
		const databases = this.settings.databases.filter((entry) =>
			mode === "pull"
				? entry.direction === "pull" || entry.direction === "bidirectional"
				: entry.direction === "push" || entry.direction === "bidirectional"
		);
		if (databases.length === 0) {
			this.openFreezeModal();
			return;
		}

		new DatabasePickerModal(this.app, databases, (entry) => {
			if (mode === "push") {
				void this.pushOneConfiguredDatabase(entry);
			} else {
				void this.syncOneConfiguredDatabase(entry);
			}
		}, mode).open();
	}

	async syncOneConfiguredDatabase(entry: SyncedDatabase, type: SyncRunType = "full", retryRowIds?: string[]): Promise<void> {
		if (this.isSyncActive(entry.id)) {
			new Notice(`Sync already running for ${entry.name}.`);
			return;
		}
		const run = await this.beginSync(entry, type, retryRowIds);
		try {
			new Notice(`Syncing ${entry.name}...`);
			const result = await this.syncConfiguredDatabase(entry, resolveOutputFolder(this.settings, entry), run.options);
			const now = new Date().toISOString();
			const errors = run.errors.length > 0
				? run.errors
				: syncErrorsFromMessages(result.errors, "pull", now);
			const status = errors.length > 0 || result.failed > 0 ? "partial" : "ok";
			this.settings = updateDatabase(this.settings, applyPhaseTransition({
				...entry,
				lastSyncedAt: now,
				lastPulledAt: now,
				lastSyncStatus: status,
				lastSyncError: errors.length > 0 ? errors.map((error) => error.error).join("\n").slice(0, 200) : undefined,
				lastSyncErrors: errors,
				lastCommittedRowId: run.lastCommittedRowId,
				current_sync_id: null,
			}, status, errors, run.type, now));
			await this.saveSettings();
			(this.app.workspace as any).trigger("stonerelay:settings-updated");
			new Notice(`Sync complete: ${entry.name}`);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const cancelled = err instanceof SyncCancelled;
			const now = new Date().toISOString();
			this.settings = updateDatabase(this.settings, {
				...entry,
				lastSyncedAt: cancelled ? now : entry.lastSyncedAt,
				lastSyncStatus: cancelled ? "cancelled" : "error",
				lastSyncError: cancelled ? undefined : message.slice(0, 200),
				lastSyncErrors: run.errors,
				lastCommittedRowId: run.lastCommittedRowId,
				current_sync_id: null,
			});
			await this.saveSettings();
			(this.app.workspace as any).trigger("stonerelay:settings-updated");
			if (cancelled) {
				new Notice(`Sync cancelled: ${entry.name}`);
			} else {
				console.error("Notion sync error:", err);
				new Notice(`Notion sync error: ${message}`);
			}
		} finally {
			this.finishSync(entry.id);
		}
	}

	async pushOneConfiguredDatabase(entry: SyncedDatabase, type: SyncRunType = "full", retryRowIds?: string[]): Promise<void> {
		if (this.isSyncActive(entry.id)) {
			new Notice(`Sync already running for ${entry.name}.`);
			return;
		}
		const run = await this.beginSync(entry, type, retryRowIds);
		try {
			new Notice(`Pushing ${entry.name}...`);
			const result = await this.pushConfiguredDatabase(entry, resolveOutputFolder(this.settings, entry), run.options);
			const now = new Date().toISOString();
			const errors = run.errors.length > 0
				? run.errors
				: syncErrorsFromMessages(result.errors, "push", now);
			const status = errors.length > 0 || result.failed > 0 ? "partial" : "ok";
			this.settings = updateDatabase(this.settings, applyPhaseTransition({
				...entry,
				lastSyncedAt: now,
				lastPushedAt: now,
				lastSyncStatus: status,
				lastSyncError: errors.length > 0 ? errors.map((error) => error.error).join("\n").slice(0, 200) : undefined,
				lastSyncErrors: errors,
				lastCommittedRowId: run.lastCommittedRowId,
				current_sync_id: null,
			}, status, errors, run.type, now));
			await this.saveSettings();
			(this.app.workspace as any).trigger("stonerelay:settings-updated");
			new Notice(formatDatabaseResult(result.title, result, "pushed"));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const cancelled = err instanceof SyncCancelled;
			const now = new Date().toISOString();
			this.settings = updateDatabase(this.settings, {
				...entry,
				lastSyncedAt: cancelled ? now : entry.lastSyncedAt,
				lastSyncStatus: cancelled ? "cancelled" : "error",
				lastSyncError: cancelled ? undefined : message.slice(0, 200),
				lastSyncErrors: run.errors,
				lastCommittedRowId: run.lastCommittedRowId,
				current_sync_id: null,
			});
			await this.saveSettings();
			(this.app.workspace as any).trigger("stonerelay:settings-updated");
			if (cancelled) {
				new Notice(`Sync cancelled: ${entry.name}`);
			} else {
				console.error("Stonerelay push error:", err);
				new Notice(`Stonerelay push error: ${message}`);
			}
		} finally {
			this.finishSync(entry.id);
		}
	}

	async retryFailedRows(entry: SyncedDatabase): Promise<void> {
		if (entry.lastSyncErrors.length === 0) return;
		const retryIds = entry.lastSyncErrors.map((error) => error.rowId);
		if (entry.direction === "push") {
			await this.pushOneConfiguredDatabase(entry, "retry", retryIds);
			return;
		}
		await this.syncOneConfiguredDatabase(entry, "retry", retryIds);
	}

	async applyConflictResolution(conflict: Conflict, action: "pull" | "push"): Promise<void> {
		const entry = this.settings.databases.find((candidate) => candidate.direction === "bidirectional");
		if (!entry) throw new Error("No bidirectional database configured for conflict resolution.");
		if (action === "pull") {
			await this.syncOneConfiguredDatabase(entry, "retry", [conflict.rowId]);
			return;
		}
		const vaultPath = typeof conflict.vaultSnapshot.path === "string"
			? conflict.vaultSnapshot.path
			: conflict.rowId;
		await this.pushOneConfiguredDatabase(entry, "retry", [vaultPath]);
	}

	async syncConfiguredDatabase(
		entry: SyncedDatabase,
		outputFolder: string,
		options: SyncRunOptions = {}
	): Promise<DatabaseSyncResult> {
		return this.syncDatabase(entry.databaseId, outputFolder, entry.lastSyncedAt, entry, {
			...options,
			bidirectional: entry.direction === "bidirectional" && !options.retryRowIds
				? {
					sourceOfTruth: entry.source_of_truth,
					lastSyncedAt: entry.lastSyncedAt,
					onConflict: (conflict) => {
						this.settings = {
							...this.settings,
							pendingConflicts: upsertConflict(this.settings.pendingConflicts, conflict),
						};
					},
				}
				: options.bidirectional,
		});
	}

	async pushConfiguredDatabase(
		entry: SyncedDatabase,
		sourceFolder: string,
		options: SyncRunOptions = {}
	): Promise<DatabaseSyncResult> {
		if (!this.settings.apiKey) {
			new Notice("Notion API key not set. Configure in plugin settings.");
			throw new Error("Notion API key not set.");
		}

		const client = createNotionClient(this.settings.apiKey);
		const notice = new Notice(`Pushing "${entry.name}" to Notion...`, 0);
		try {
			const result = await pushDatabase(
				this.app,
				client,
				normalizeNotionId(entry.databaseId),
				sourceFolder,
				options
			);
			notice.hide();
			return result;
		} catch (err) {
			notice.hide();
			throw err;
		}
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
		outputFolder: string,
		lastSyncedAt?: string | null,
		entry?: SyncedDatabase,
		options: SyncRunOptions = {}
	): Promise<DatabaseSyncResult> {
		if (!this.settings.apiKey) {
			new Notice("Notion API key not set. Configure in plugin settings.");
			throw new Error("Notion API key not set.");
		}

		const normalizedId = normalizeNotionId(databaseId);
		const existing = this.findFrozenDatabase(normalizedId);
		if (existing) {
			return this.refreshFrozenDatabase(existing, lastSyncedAt, options);
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
				},
				{
					...options,
					nestUnderDbName: entry?.nest_under_db_name ?? true,
				}
			);
			notice.hide();
			return result;
		} catch (err) {
			notice.hide();
			throw err;
		}
	}

	private async refreshFrozenDatabase(
		db: FrozenDatabase,
		lastSyncedAt?: string | null,
		options: SyncRunOptions = {}
	): Promise<DatabaseSyncResult> {
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
				lastSyncedAt,
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
				},
				options
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

	private async beginSync(entry: SyncedDatabase, type: SyncRunType = "full", retryRowIds?: string[]): Promise<{
		type: SyncRunType;
		errors: SyncError[];
		get lastCommittedRowId(): string | null;
		options: SyncRunOptions;
	}> {
		const controller = new AbortController();
		const syncId = crypto.randomUUID();
		const errors: SyncError[] = [];
		const state = { lastCommittedRowId: entry.lastCommittedRowId };
		this.syncControllers.set(entry.id, controller);
		this.settings = updateDatabase(this.settings, {
			...entry,
			current_sync_id: syncId,
			lastSyncErrors: type === "full" ? [] : entry.lastSyncErrors,
		});
		await this.saveSettings();
		return {
			type,
			errors,
			get lastCommittedRowId() {
				return state.lastCommittedRowId;
			},
			options: {
				signal: controller.signal,
				startAfterRowId: entry.lastSyncStatus === "cancelled" ? entry.lastCommittedRowId : null,
				retryRowIds: type === "retry" ? retryRowIds ?? entry.lastSyncErrors.map((error) => error.rowId) : undefined,
				onRowCommitted: (rowId) => {
					state.lastCommittedRowId = rowId;
				},
				onRowError: (error) => {
					errors.push(error);
				},
			},
		};
	}

	private finishSync(entryId: string): void {
		this.syncControllers.delete(entryId);
		if (this.cancellingAll && this.syncControllers.size === 0) {
			this.cancellingAll = false;
		}
		(this.app.workspace as any).trigger("stonerelay:settings-updated");
	}

	private async markInterruptedSyncs(): Promise<void> {
		let changed = false;
		this.settings = {
			...this.settings,
			databases: this.settings.databases.map((entry) => {
				if (!entry.current_sync_id) return entry;
				changed = true;
				return {
					...entry,
					current_sync_id: null,
					lastSyncStatus: "interrupted",
					lastSyncError: "Previous sync was interrupted. Resume from cursor or restart from beginning.",
				};
			}),
		};
		if (changed) {
			await this.saveSettings();
			new Notice("A previous sync was interrupted. Resume from cursor or restart from beginning.");
		}
	}

	private async saveSettingsAtomic(settings: NotionFreezeSettings): Promise<void> {
		const adapter = this.app.vault.adapter as PluginDataAdapter;
		const dataPath = `.obsidian/plugins/${this.manifest.id}/data.json`;
		const payload = `${JSON.stringify(settings, null, 2)}\n`;
		await writePluginDataAtomic(adapter, dataPath, payload, async () => {
			await this.saveData(settings);
		});
	}
}

function upsertConflict(conflicts: Conflict[], conflict: Conflict): Conflict[] {
	return [
		...conflicts.filter((existing) => existing.rowId !== conflict.rowId),
		conflict,
	];
}

class DatabasePickerModal extends SuggestModal<SyncedDatabase> {
	private databases: SyncedDatabase[];
	private onChoose: (entry: SyncedDatabase) => void;
	private mode: "pull" | "push";

	constructor(
		app: App,
		databases: SyncedDatabase[],
		onChoose: (entry: SyncedDatabase) => void,
		mode: "pull" | "push" = "pull"
	) {
		super(app);
		this.databases = databases;
		this.onChoose = onChoose;
		this.mode = mode;
		this.setPlaceholder(`Choose a Stonerelay database to ${mode}`);
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
			text: `${entry.enabled ? "Enabled" : "Disabled"} · ${entry.direction} · ${entry.outputFolder || "Default folder"}`,
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
