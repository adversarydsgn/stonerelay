import { addIcon, App, Modal, Notice, Plugin, Setting, SuggestModal, normalizePath, TFile, TFolder } from "obsidian";
import { AtomicWriteEvent, Conflict, NotionFreezeSettings, DatabaseSyncResult, PageSyncEntry, SyncError, SyncRunOptions, SyncRunType, SyncedDatabase } from "./types";
import { NotionFreezeSettingTab } from "./settings";
import { FreezeModal, FrozenDatabase } from "./freeze-modal";
import { createNotionClient, normalizeNotionId, notionRequest } from "./notion-client";
import { freshDatabaseImport, refreshDatabase } from "./database-freezer";
import { migrateData, resolveErrorLogFolder, syncAll, updateDatabase, updatePage } from "./settings-data";
import { inspectStaleNotionIdSkips, pushDatabase } from "./push";
import { applyPhaseTransition, syncErrorsFromMessages, SyncCancelled } from "./sync-state";
import { PluginDataAdapter, writePluginDataAtomic } from "./plugin-data";
import { AutoSyncJob, AutoSyncQueue, createBackgroundConflict, findAutoSyncEntryForPath, isAutoSyncEligible } from "./auto-sync";
import { importStandalonePage, refreshStandalonePage } from "./page-sync";
import { parseNotionPageId } from "./settings-ux";
import { isSafeVaultRelativePath, resolveDatabasePathModel } from "./path-model";
import { confirmStaleNotionIdSafety, evaluatePullSafety, evaluatePushSafety, retryDirectionForErrors, StaleNotionIdSafetyState } from "./sync-safety";
import { ReservationHandle, ReservationManager, ReservationOperationType, ReservationPolicy, ReservationRejectedError } from "./reservations";
import { appendIntentRecord, PushIntentLog, PushIntentRecovery, recoverPushIntents } from "./push-intents";
import { modifyAtomic } from "./atomic-vault-write";

export default class NotionFreezePlugin extends Plugin {
	settings: NotionFreezeSettings = migrateData(null);
	private syncControllers = new Map<string, AbortController>();
	private syncReservations = new Map<string, ReservationHandle>();
	private reservations = new ReservationManager();
	private pushIntentRecoveries: PushIntentRecovery[] = [];
	private lastBackfilledByEntry = new Map<string, number>();
	private atomicWriteEvents: AtomicWriteEvent[] = [];
	private cancellingAll = false;
	private autoSyncQueue = new AutoSyncQueue((job) => this.runAutoSyncJob(job));

	async onload(): Promise<void> {
		await this.loadSettings();
		await this.markInterruptedSyncs();
		this.addSettingTab(new NotionFreezeSettingTab(this.app, this));
		this.registerAutoSyncWatchers();

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

		this.addCommand({
			id: "stonerelay:import-page",
			name: "Stonerelay: Import standalone page",
			callback: () => {
				new PageImportModal(this.app, this, (input, outputFolder) => {
					void this.importStandalonePageInput(input, outputFolder);
				}).open();
			},
		});
	}

	async loadSettings(): Promise<void> {
		const raw = await this.loadData();
		this.settings = migrateData(raw);
		if (!raw?.schemaVersion || raw.schemaVersion < 5) {
			await this.saveSettings();
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveSettingsAtomic(this.settings);
	}

	isSyncActive(entryId: string): boolean {
		return this.syncControllers.has(entryId) || this.reservations.hasEntry(entryId);
	}

	isCancellingAll(): boolean {
		return this.cancellingAll;
	}

	hasActiveSyncs(): boolean {
		return this.reservations.size() > 0;
	}

	cancelSync(entryId: string): void {
		const controller = this.syncControllers.get(entryId);
		if (!controller && !this.reservations.cancel(entryId)) return;
		controller?.abort();
		new Notice("Cancelling sync. Finishing this row first.");
		(this.app.workspace as any).trigger("stonerelay:settings-updated");
	}

	cancelAllSyncs(): void {
		if (this.reservations.size() === 0) return;
		this.cancellingAll = true;
		this.reservations.cancelAll();
		for (const controller of this.syncControllers.values()) controller.abort();
		if (this.reservations.size() > 0) {
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
				const unsafe = this.pullSafetyBlocker(entry);
				if (unsafe) throw new Error(unsafe);
				const folder = resolveDatabasePathModel(this.settings, entry, {
					discoveredContentFolder: this.findFrozenDatabase(normalizeNotionId(entry.databaseId))?.folderPath ?? null,
				}).pullTargetFolder;
				const run = await this.beginSync(entry, "full", undefined, "pull", "batch", folder);
				try {
					const result = await this.syncConfiguredDatabase(entry, outputFolder, run.options);
					this.recordBackfilledCount(entry.id, result.backfilled ?? 0);
					return result;
				} finally {
					this.finishSync(entry.id);
				}
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
			async (entry) => {
				this.assertSafePushFolder(entry, { allowDisabledEntry: false });
				const sourceFolder = this.resolvePushSourceFolder(entry);
				const run = await this.beginSync(entry, "full", undefined, "push", "batch", sourceFolder);
				try {
					const confirmed = await this.confirmStaleIdThresholdIfNeeded(entry, sourceFolder);
					if (!confirmed) throw new Error("Push cancelled: stale notion-id threshold requires operator confirmation.");
					return await this.pushConfiguredDatabase(entry, sourceFolder, {
						...run.options,
						allowStaleNotionIdThresholdProceed: true,
					});
				} finally {
					this.finishSync(entry.id);
				}
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
		const unsafe = this.pullSafetyBlocker(entry, { retryRowIds });
		if (unsafe) {
			new Notice(unsafe);
			return;
		}
		const outputFolder = resolveDatabasePathModel(this.settings, entry, {
			discoveredContentFolder: this.findFrozenDatabase(normalizeNotionId(entry.databaseId))?.folderPath ?? null,
		}).configuredParentFolder;
		let run: Awaited<ReturnType<typeof this.beginSync>>;
		try {
			run = await this.beginSync(entry, type, retryRowIds, "pull", "manual", outputFolder);
		} catch (err) {
			this.noticeReservationError(err);
			return;
		}
		try {
			new Notice(`Syncing ${entry.name}...`);
			const result = await this.syncConfiguredDatabase(
				entry,
				outputFolder,
				run.options
			);
			this.recordBackfilledCount(entry.id, result.backfilled ?? 0);
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
			if (status === "partial") {
				await this.writeSyncErrorLog(entry, "pull", now, errors, run.lastCommittedRowId);
			}
			await this.saveSettings();
			(this.app.workspace as any).trigger("stonerelay:settings-updated");
			new Notice(formatDatabaseResult(result.title, result, "synced"));
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
			if (!cancelled) {
				await this.writeSyncErrorLog(entry, "pull", now, [{
					rowId: run.lastCommittedRowId ?? "unknown",
					direction: "pull",
					error: message,
					timestamp: now,
				}], run.lastCommittedRowId);
			}
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

	async pushOneConfiguredDatabase(entry: SyncedDatabase, type: SyncRunType = "full", retryRowIds?: string[], safetyOptions: {
		allowPendingConflicts?: boolean;
	} = {}): Promise<void> {
		if (this.isSyncActive(entry.id)) {
			new Notice(`Sync already running for ${entry.name}.`);
			return;
		}
		const unsafe = this.pushSafetyBlocker(entry, {
			retryRowIds,
			allowDisabledEntry: true,
			allowPendingConflicts: safetyOptions.allowPendingConflicts ?? false,
		});
		if (unsafe) {
			new Notice(unsafe);
			return;
		}
		const sourceFolder = this.resolvePushSourceFolder(entry);
		let run: Awaited<ReturnType<typeof this.beginSync>>;
		try {
			run = await this.beginSync(entry, type, retryRowIds, "push", "manual", sourceFolder);
		} catch (err) {
			this.noticeReservationError(err);
			return;
		}
		try {
			const confirmed = await this.confirmStaleIdThresholdIfNeeded(entry, sourceFolder);
			if (!confirmed) {
				throw new SyncCancelled();
			}
			new Notice(`Pushing ${entry.name}...`);
			const result = await this.pushConfiguredDatabase(entry, sourceFolder, {
				...run.options,
				allowStaleNotionIdThresholdProceed: true,
			});
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
			if (status === "partial") {
				await this.writeSyncErrorLog(entry, "push", now, errors, run.lastCommittedRowId);
			}
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
			if (!cancelled) {
				await this.writeSyncErrorLog(entry, "push", now, [{
					rowId: run.lastCommittedRowId ?? "unknown",
					direction: "push",
					error: message,
					timestamp: now,
				}], run.lastCommittedRowId);
			}
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
		const retryDirection = retryDirectionForErrors(entry.lastSyncErrors);
		if (retryDirection === "mixed") {
			new Notice(`Retry blocked for ${entry.name}: failed rows include both pull row IDs and push vault paths.`);
			return;
		}
		if (retryDirection === "push") {
			await this.pushOneConfiguredDatabase(entry, "retry", retryIds);
			return;
		}
		await this.syncOneConfiguredDatabase(entry, "retry", retryIds);
	}

	private async confirmStaleIdThresholdIfNeeded(entry: SyncedDatabase, sourceFolder: string): Promise<boolean> {
		if (!this.settings.apiKey) return true;
		const client = createNotionClient(this.settings.apiKey);
		const state = await inspectStaleNotionIdSkips(
			this.app,
			client,
			normalizeNotionId(entry.databaseId),
			sourceFolder
		);
		if (state.kind !== "requires-stale-id-confirmation") return true;
		return confirmStaleNotionIdSafety(state, (message) => new Promise((resolve) => {
			new StaleNotionIdConfirmationModal(this.app, state, message, resolve).open();
		}));
	}

	private assertSafePushFolder(entry: SyncedDatabase, options: {
		retryRowIds?: string[];
		allowDisabledEntry?: boolean;
		allowPendingConflicts?: boolean;
	} = {}): void {
		const message = this.pushSafetyBlocker(entry, options);
		if (message) throw new Error(message);
	}

	private pushSafetyBlocker(entry: SyncedDatabase, options: {
		retryRowIds?: string[];
		allowDisabledEntry?: boolean;
		allowPendingConflicts?: boolean;
	} = {}): string | null {
		const discoveredContentFolder = this.findFrozenDatabase(normalizeNotionId(entry.databaseId))?.folderPath ?? null;
		const pathModel = resolveDatabasePathModel(this.settings, entry, { discoveredContentFolder });
		const source = this.app.vault.getAbstractFileByPath(pathModel.pushSourceFolder);
		const decision = evaluatePushSafety({
			settings: this.settings,
			entry,
			discoveredContentFolder,
			folderExists: source instanceof TFolder,
			retryRowIds: options.retryRowIds,
			allowDisabledEntry: options.allowDisabledEntry,
			allowPendingConflicts: options.allowPendingConflicts,
		});
		return decision.hardBlocks[0]?.message ?? null;
	}

	private pullSafetyBlocker(entry: SyncedDatabase, options: { retryRowIds?: string[] } = {}): string | null {
		const discoveredContentFolder = this.findFrozenDatabase(normalizeNotionId(entry.databaseId))?.folderPath ?? null;
		const decision = evaluatePullSafety({
			settings: this.settings,
			entry,
			discoveredContentFolder,
			retryRowIds: options.retryRowIds,
		});
		return decision.hardBlocks[0]?.message ?? null;
	}

	private resolvePushSourceFolder(entry: SyncedDatabase): string {
		const existing = this.findFrozenDatabase(normalizeNotionId(entry.databaseId));
		return resolveDatabasePathModel(this.settings, entry, {
			discoveredContentFolder: existing?.folderPath ?? null,
		}).pushSourceFolder;
	}

	async importStandalonePageInput(input: string, outputFolder?: string): Promise<PageSyncEntry | null> {
		const pageId = parseNotionPageId(input);
		if (!pageId) {
			new Notice("Invalid Notion page URL or ID.");
			return null;
		}
		if (!this.settings.apiKey) {
			new Notice("Notion API key not set. Configure in plugin settings.");
			throw new Error("Notion API key not set.");
		}
		const client = createNotionClient(this.settings.apiKey);
		const folder = outputFolder?.trim() || this.settings.defaultOutputFolder || "_relay";
		const reservation = await this.reservations.acquire({
			entryId: `page:${pageId}`,
			entryName: pageId,
			databaseId: pageId,
			vaultFolder: folder,
			type: "page",
			policy: "manual",
		});
		try {
			const result = await importStandalonePage(this.app, client, pageId, folder, {
				signal: reservation.signal,
				reservationId: reservation.id,
				onAtomicWriteCommitted: (path) => this.recordAtomicWriteCommitted(path, reservation.id),
			});
			const now = new Date().toISOString();
			const existing = this.settings.pages.find((page) => page.pageId === pageId);
			const nextPage: PageSyncEntry = {
				id: existing?.id ?? crypto.randomUUID(),
				type: "page",
				name: result.title,
				pageId,
				outputFolder: folder,
				errorLogFolder: existing?.errorLogFolder ?? "",
				groupId: existing?.groupId ?? null,
				enabled: existing?.enabled ?? true,
				autoSync: existing?.autoSync ?? "inherit",
				lastSyncedAt: now,
				lastSyncStatus: "ok",
				lastSyncError: undefined,
				current_sync_id: null,
				lastFilePath: result.filePath,
			};
			this.settings = existing
				? updatePage(this.settings, nextPage)
				: { ...this.settings, pages: [...this.settings.pages, nextPage] };
			await this.saveSettings();
			(this.app.workspace as any).trigger("stonerelay:settings-updated");
			new Notice(`Imported page: ${result.title}`);
			return nextPage;
		} finally {
			reservation.release();
		}
	}

	async refreshOnePage(entry: PageSyncEntry): Promise<void> {
		if (this.isSyncActive(entry.id)) {
			new Notice(`Sync already running for ${entry.name}.`);
			return;
		}
		if (!this.settings.apiKey) {
			new Notice("Notion API key not set. Configure in plugin settings.");
			throw new Error("Notion API key not set.");
		}
		const reservation = await this.reservations.acquire({
			entryId: entry.id,
			entryName: entry.name,
			databaseId: entry.pageId,
			vaultFolder: entry.outputFolder,
			type: "page",
			policy: "manual",
		});
		const syncId = reservation.id;
		this.syncControllers.set(entry.id, reservation.controller);
		this.syncReservations.set(entry.id, reservation);
		this.settings = updatePage(this.settings, {
			...entry,
			current_sync_id: syncId,
		});
		await this.saveSettings();
		try {
			const client = createNotionClient(this.settings.apiKey);
			const result = await refreshStandalonePage(this.app, client, entry, {
				signal: reservation.signal,
				reservationId: reservation.id,
				onAtomicWriteCommitted: (path) => this.recordAtomicWriteCommitted(path, reservation.id),
			});
			const now = new Date().toISOString();
			this.settings = updatePage(this.settings, {
				...entry,
				name: result.title,
				lastSyncedAt: now,
				lastSyncStatus: "ok",
				lastSyncError: undefined,
				current_sync_id: null,
				lastFilePath: result.filePath,
			});
			await this.saveSettings();
			new Notice(`Refreshed page: ${result.title}`);
		} catch (err) {
			const now = new Date().toISOString();
			const message = err instanceof Error ? err.message : String(err);
			this.settings = updatePage(this.settings, {
				...entry,
				lastSyncStatus: "error",
				lastSyncError: message.slice(0, 200),
				current_sync_id: null,
			});
			await this.writePageErrorLog(entry, "refresh", now, message, entry.lastFilePath ?? undefined);
			await this.saveSettings();
			throw err;
		} finally {
			this.finishSync(entry.id);
		}
		(this.app.workspace as any).trigger("stonerelay:settings-updated");
	}

	async applyConflictResolution(conflict: Conflict, action: "pull" | "push"): Promise<void> {
		const entry = this.settings.databases.find((candidate) =>
			conflict.entryId ? candidate.id === conflict.entryId : candidate.direction === "bidirectional"
		);
		if (!entry) throw new Error("No bidirectional database configured for conflict resolution.");
		if (action === "pull") {
			await this.syncOneConfiguredDatabase(entry, "retry", [conflict.rowId]);
			return;
		}
		const vaultPath = typeof conflict.vaultSnapshot.path === "string"
			? conflict.vaultSnapshot.path
			: conflict.rowId;
		await this.pushOneConfiguredDatabase(entry, "retry", [vaultPath], { allowPendingConflicts: true });
	}

	async syncConfiguredDatabase(
		entry: SyncedDatabase,
		outputFolder: string,
		options: SyncRunOptions = {}
	): Promise<DatabaseSyncResult> {
		this.requireActiveReservation(options.reservationId, "configured database pull");
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
						void this.writeConflictLog(entry, conflict);
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
		this.requireActiveReservation(options.reservationId, "configured database push");
		if (!this.settings.apiKey) {
			new Notice("Notion API key not set. Configure in plugin settings.");
			throw new Error("Notion API key not set.");
		}

		const client = createNotionClient(this.settings.apiKey);
		const notice = new Notice(`Pushing "${entry.name}" to Notion...`, 0);
		const pushIntentLogger = options.reservationId ? this.createPushIntentLogger(options.reservationId) : null;
		try {
			const result = await pushDatabase(
				this.app,
				client,
				normalizeNotionId(entry.databaseId),
				sourceFolder,
				{
					...options,
					onPushIntentCreating: options.onPushIntentCreating ?? pushIntentLogger?.recordCreating.bind(pushIntentLogger),
					onPushIntentCreated: options.onPushIntentCreated ?? pushIntentLogger?.recordCreated.bind(pushIntentLogger),
					onPushIntentCommitted: options.onPushIntentCommitted ?? pushIntentLogger?.recordCommitted.bind(pushIntentLogger),
				}
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
		let reservation: ReservationHandle | null = null;
		try {
			const databaseId = normalizeNotionId(input);
			reservation = await this.reservations.acquire({
				entryId: `fresh:${databaseId}`,
				entryName: databaseId,
				databaseId,
				vaultFolder: outputFolder,
				type: "pull",
				policy: "manual",
			});
			const activeReservation = reservation;
			const result = await this.syncDatabase(databaseId, outputFolder, undefined, undefined, {
				signal: activeReservation.signal,
				reservationId: activeReservation.id,
				onAtomicWriteCommitted: (path) => this.recordAtomicWriteCommitted(path, activeReservation.id),
			});
			new Notice(formatDatabaseResult(result.title, result, "imported"));
		} catch (err) {
			console.error("Notion sync error:", err);
			new Notice(
				`Notion sync error: ${err instanceof Error ? err.message : String(err)}`
			);
		} finally {
			reservation?.release();
		}
	}

	private async executeRefresh(db: FrozenDatabase): Promise<void> {
		let reservation: ReservationHandle | null = null;
		try {
			reservation = await this.reservations.acquire({
				entryId: `refresh:${db.databaseId}`,
				entryName: db.title,
				databaseId: db.databaseId,
				vaultFolder: db.folderPath,
				type: "pull",
				policy: "manual",
			});
			const activeReservation = reservation;
			const result = await this.refreshFrozenDatabase(db, undefined, {
				signal: activeReservation.signal,
				reservationId: activeReservation.id,
				onAtomicWriteCommitted: (path) => this.recordAtomicWriteCommitted(path, activeReservation.id),
			});
			new Notice(formatDatabaseResult(result.title, result, "re-synced"));
		} catch (err) {
			console.error("Notion sync error:", err);
			new Notice(
				`Notion sync error: ${err instanceof Error ? err.message : String(err)}`
			);
		} finally {
			reservation?.release();
		}
	}

	private async syncDatabase(
		databaseId: string,
		outputFolder: string,
		lastSyncedAt?: string | null,
		entry?: SyncedDatabase,
		options: SyncRunOptions = {}
	): Promise<DatabaseSyncResult> {
		this.requireActiveReservation(options.reservationId, "database sync");
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
		this.requireActiveReservation(options.reservationId, "frozen database refresh");
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

	private async beginSync(
		entry: SyncedDatabase,
		type: SyncRunType = "full",
		retryRowIds?: string[],
		operation: ReservationOperationType = "pull",
		policy: ReservationPolicy = "manual",
		vaultFolder = entry.outputFolder
	): Promise<{
		type: SyncRunType;
		errors: SyncError[];
		get lastCommittedRowId(): string | null;
		options: SyncRunOptions;
	}> {
		const reservation = await this.reservations.acquire({
			entryId: entry.id,
			entryName: entry.name,
			databaseId: entry.databaseId,
			vaultFolder,
			type: operation,
			policy,
			maxQueueDepth: policy === "batch" ? 3 : 1,
		});
		const controller = reservation.controller;
		const syncId = reservation.id;
		const errors: SyncError[] = [];
		const state = { lastCommittedRowId: entry.lastCommittedRowId };
		this.syncControllers.set(entry.id, controller);
		this.syncReservations.set(entry.id, reservation);
		this.settings = updateDatabase(this.settings, {
			...entry,
			current_sync_id: syncId,
			lastSyncErrors: type === "full" ? [] : entry.lastSyncErrors,
		});
		this.settings = {
			...this.settings,
			active_reservations: this.reservations.snapshots(),
		};
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
				reservationId: reservation.id,
				onAtomicWriteCommitted: (path) => this.recordAtomicWriteCommitted(path, reservation.id),
			},
		};
	}

	private finishSync(entryId: string): void {
		this.syncControllers.delete(entryId);
		this.syncReservations.get(entryId)?.release();
		this.syncReservations.delete(entryId);
		this.settings = {
			...this.settings,
			active_reservations: this.reservations.snapshots(),
		};
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
			pages: this.settings.pages.map((entry) => {
				if (!entry.current_sync_id) return entry;
				changed = true;
				return {
					...entry,
					current_sync_id: null,
					lastSyncStatus: "interrupted",
					lastSyncError: "Previous page refresh was interrupted. Refresh again when ready.",
				};
			}),
		};
		if (changed) {
			try {
				await this.saveSettings();
			} catch (err) {
				console.warn(`Stonerelay: failed to persist interrupted sync recovery during startup (${errorMessage(err)}).`);
			}
			new Notice("A previous sync was interrupted. Resume from cursor or restart from beginning.");
		}
		await this.recoverPushIntentLog();
	}

	private async saveSettingsAtomic(settings: NotionFreezeSettings): Promise<void> {
		const adapter = this.app.vault.adapter as PluginDataAdapter;
		const dataPath = `.obsidian/plugins/${this.manifest.id}/data.json`;
		const payload = `${JSON.stringify({ ...settings, active_reservations: [] }, null, 2)}\n`;
		await writePluginDataAtomic(adapter, dataPath, payload, async () => {
			await this.saveData({ ...settings, active_reservations: [] });
		});
	}

	private createPushIntentLogger(reservationId: string): PushIntentLog {
		const adapter = this.app.vault.adapter as PluginDataAdapter;
		return new PushIntentLog(adapter, `.obsidian/plugins/${this.manifest.id}/push-intents.jsonl`, reservationId);
	}

	private async recoverPushIntentLog(): Promise<void> {
		const adapter = this.app.vault.adapter as PluginDataAdapter;
		this.pushIntentRecoveries = await recoverPushIntents(adapter, `.obsidian/plugins/${this.manifest.id}/push-intents.jsonl`);
		if (this.pushIntentRecoveries.length > 0) {
			new Notice(`${this.pushIntentRecoveries.length} interrupted Push intent${this.pushIntentRecoveries.length === 1 ? "" : "s"} need recovery. See diagnostics.`);
		}
	}

	getActiveOperationSnapshots() {
		return this.reservations.snapshots();
	}

	getPushIntentRecoveries(): PushIntentRecovery[] {
		return [...this.pushIntentRecoveries];
	}

	getLastBackfilledFileCount(entryId: string): number {
		return this.lastBackfilledByEntry.get(entryId) ?? 0;
	}

	getAtomicWriteEvents(): AtomicWriteEvent[] {
		return [...this.atomicWriteEvents];
	}

	async applyPushIntentRecovery(intentId: string): Promise<void> {
		const recovery = this.findPushIntentRecovery(intentId);
		if (!recovery) {
			new Notice("Push intent recovery is no longer pending.");
			return;
		}
		if (!isSafeVaultRelativePath(recovery.vaultPath)) {
			new Notice(`Push intent recovery blocked: unsafe vault path ${recovery.vaultPath}.`);
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(recovery.vaultPath);
		if (!(file instanceof TFile)) {
			new Notice(`Push intent recovery blocked: local file not found at ${recovery.vaultPath}.`);
			return;
		}
		const reservation = await this.reservations.acquire({
			entryId: `push-intent:${intentId}`,
			entryName: recovery.vaultPath,
			databaseId: recovery.notionId,
			vaultFolder: file.parent?.path ?? recovery.vaultPath,
			type: "startup",
			policy: "manual",
		});
		try {
			const raw = await this.app.vault.cachedRead(file);
			const next = upsertFrontmatterValue(raw, "notion-id", recovery.notionId);
			if (next !== raw) {
				await modifyAtomic(this.app.vault, file, next, {
					onCommitted: (path) => this.recordAtomicWriteCommitted(path, reservation.id),
				});
			}
			await appendIntentRecord(this.app.vault.adapter as PluginDataAdapter, `.obsidian/plugins/${this.manifest.id}/push-intents.jsonl`, {
				intent_id: recovery.intentId,
				reservation_id: reservation.id,
				vault_path: recovery.vaultPath,
				title_hash: "",
				phase: "committed",
				notion_id: recovery.notionId,
				completed_at: new Date().toISOString(),
			});
			this.removePushIntentRecovery(intentId);
			new Notice(`Applied recovered Notion id to ${recovery.vaultPath}.`);
		} catch (err) {
			new Notice(`Push intent recovery failed: ${errorMessage(err)}`);
			throw err;
		} finally {
			reservation.release();
			(this.app.workspace as any).trigger("stonerelay:settings-updated");
		}
	}

	async archivePushIntentRecovery(intentId: string): Promise<void> {
		const recovery = this.findPushIntentRecovery(intentId);
		if (!recovery) {
			new Notice("Push intent recovery is no longer pending.");
			return;
		}
		if (!this.settings.apiKey) {
			new Notice("Notion API key not set. Configure in plugin settings before archiving the orphan page.");
			return;
		}
		const reservation = await this.reservations.acquire({
			entryId: `push-intent:${intentId}`,
			entryName: recovery.vaultPath,
			databaseId: recovery.notionId,
			vaultFolder: parentPath(recovery.vaultPath),
			type: "startup",
			policy: "manual",
		});
		try {
			const client = createNotionClient(this.settings.apiKey);
			await notionRequest(() => client.pages.update({
				page_id: recovery.notionId,
				archived: true,
			} as never));
			await appendIntentRecord(this.app.vault.adapter as PluginDataAdapter, `.obsidian/plugins/${this.manifest.id}/push-intents.jsonl`, {
				intent_id: recovery.intentId,
				reservation_id: reservation.id,
				vault_path: recovery.vaultPath,
				title_hash: "",
				phase: "archived",
				notion_id: recovery.notionId,
				completed_at: new Date().toISOString(),
			});
			this.removePushIntentRecovery(intentId);
			new Notice(`Archived orphan Notion page for ${recovery.vaultPath}.`);
		} catch (err) {
			new Notice(`Push intent archive failed: ${errorMessage(err)}`);
			throw err;
		} finally {
			reservation.release();
			(this.app.workspace as any).trigger("stonerelay:settings-updated");
		}
	}

	private noticeReservationError(err: unknown): void {
		if (err instanceof ReservationRejectedError) {
			new Notice(err.message);
			return;
		}
		throw err;
	}

	private requireActiveReservation(reservationId: string | undefined, writer: string): void {
		if (!reservationId || !this.reservations.hasReservation(reservationId)) {
			throw new Error(`Reservation required before ${writer}.`);
		}
	}

	private recordBackfilledCount(entryId: string, count: number): void {
		this.lastBackfilledByEntry.set(entryId, count);
	}

	private recordAtomicWriteCommitted(path: string, reservationId?: string): void {
		this.atomicWriteEvents = [
			...this.atomicWriteEvents.slice(-49),
			{ path, reservationId, committedAt: new Date().toISOString() },
		];
	}

	private findPushIntentRecovery(intentId: string): PushIntentRecovery | null {
		return this.pushIntentRecoveries.find((recovery) => recovery.intentId === intentId) ?? null;
	}

	private removePushIntentRecovery(intentId: string): void {
		this.pushIntentRecoveries = this.pushIntentRecoveries.filter((recovery) => recovery.intentId !== intentId);
	}

	private async writeSyncErrorLog(
		entry: SyncedDatabase,
		direction: "pull" | "push",
		timestamp: string,
		errors: SyncError[],
		lastCommittedRowId: string | null
	): Promise<void> {
		const folder = resolveErrorLogFolder(this.settings, entry);
		if (!folder || !isSafeVaultRelativePath(folder)) return;
		const body = [
			"# Stonerelay sync error",
			"",
			`timestamp: ${timestamp}`,
			`database_name: ${entry.name}`,
			`database_id: ${entry.databaseId}`,
			`run_type: ${direction}`,
			`last_committed_row_id: ${lastCommittedRowId ?? "none"}`,
			"",
			"## Errors",
			...errors.map((error) => [
				`- row_or_path: ${error.rowId}`,
				`  code: ${error.errorCode ?? "unknown"}`,
				`  message: ${error.error}`,
			].join("\n")),
			"",
		].join("\n");
		await this.writeVaultLog(folder, `${timestampedFilePrefix(timestamp)}-${entry.id}-${direction}.md`, body);
	}

	private async writePageErrorLog(
		entry: PageSyncEntry,
		runType: "refresh" | "auto-refresh",
		timestamp: string,
		error: string,
		filePath?: string
	): Promise<void> {
		const folder = resolveErrorLogFolder(this.settings, entry);
		if (!folder || !isSafeVaultRelativePath(folder)) return;
		const body = [
			"# Stonerelay page sync error",
			"",
			`timestamp: ${timestamp}`,
			"entry_type: page",
			`entry_name: ${entry.name}`,
			`notion_id: ${entry.pageId}`,
			`run_type: ${runType}`,
			`file_path: ${filePath ?? "none"}`,
			`message: ${error}`,
			"",
		].join("\n");
		await this.writeVaultLog(folder, `${timestampedFilePrefix(timestamp)}-${entry.id}-${runType}.md`, body);
	}

	private async writeConflictLog(entry: SyncedDatabase, conflict: Conflict): Promise<void> {
		const folder = resolveErrorLogFolder(this.settings, entry);
		if (!folder || !isSafeVaultRelativePath(folder)) return;
		const body = [
			"# Stonerelay conflict",
			"",
			`timestamp: ${conflict.detectedAt}`,
			`database_name: ${entry.name}`,
			`database_id: ${entry.databaseId}`,
			`row_id: ${conflict.rowId}`,
			`notion_edited_at: ${conflict.notionEditedAt}`,
			`vault_edited_at: ${conflict.vaultEditedAt}`,
			`source_of_truth: ${entry.source_of_truth ?? "unset"}`,
			"write_back_blocked: true",
			"",
		].join("\n");
		await this.writeVaultLog(folder, `${timestampedFilePrefix(conflict.detectedAt)}-${entry.id}-conflict-${safeFileToken(conflict.rowId)}.md`, body);
	}

	private registerAutoSyncWatchers(): void {
		this.registerEvent((this.app.vault as any).on("modify", (file: unknown) => {
			this.handleVaultAutoSyncEvent(file);
		}));
		this.registerEvent((this.app.vault as any).on("create", (file: unknown) => {
			this.handleVaultAutoSyncEvent(file);
		}));
		this.registerEvent((this.app.vault as any).on("rename", (file: unknown) => {
			this.handleVaultAutoSyncEvent(file);
		}));
	}

	private handleVaultAutoSyncEvent(file: unknown): void {
		if (!this.settings.autoSyncEnabled || !(file instanceof TFile) || file.extension !== "md") return;
		const candidate = findAutoSyncEntryForPath(this.settings, file.path);
		if (!candidate || !isAutoSyncEligible(this.settings, candidate)) return;
		if (candidate.type === "database") {
			const conflict = this.detectBackgroundCollision(candidate.entry, file);
			if (conflict) {
				this.settings = {
					...this.settings,
					pendingConflicts: upsertConflict(this.settings.pendingConflicts, conflict),
				};
				void this.writeConflictLog(candidate.entry, conflict);
				void this.saveSettings();
				(this.app.workspace as any).trigger("stonerelay:settings-updated");
				return;
			}
		}
		this.autoSyncQueue.enqueue({
			entryId: candidate.entry.id,
			entryType: candidate.type,
			path: file.path,
			runType: candidate.type === "page" ? "refresh" : "push",
		});
	}

	private async runAutoSyncJob(job: AutoSyncJob): Promise<void> {
		if (job.entryType === "database") {
			return;
		}
		const page = this.settings.pages.find((candidate) => candidate.id === job.entryId);
		if (!page || !isAutoSyncEligible(this.settings, { type: "page", entry: page })) return;
		await this.refreshOnePage(page);
	}

	private detectBackgroundCollision(entry: SyncedDatabase, file: TFile): Conflict | null {
		if (!entry.lastSyncedAt) return null;
		const cache = this.app.metadataCache.getFileCache(file);
		const notionEditedAt = cache?.frontmatter?.["notion-last-edited"];
		const rowId = cache?.frontmatter?.["notion-id"];
		if (typeof notionEditedAt !== "string" || typeof rowId !== "string") return null;
		const lastSynced = Date.parse(entry.lastSyncedAt);
		const notionChanged = Date.parse(notionEditedAt) > lastSynced;
		const vaultChanged = file.stat.mtime > lastSynced;
		if (!notionChanged || !vaultChanged) return null;
		return createBackgroundConflict({
			entryId: entry.id,
			entryType: "database",
			rowId,
			notionEditedAt,
			vaultEditedAt: new Date(file.stat.mtime).toISOString(),
			notionSnapshot: { rowId, lastEditedTime: notionEditedAt },
			vaultSnapshot: { path: file.path, mtime: file.stat.mtime, frontmatter: cache?.frontmatter ?? {} },
		});
	}

	private async writeVaultLog(folder: string, filename: string, body: string): Promise<void> {
		const adapter = this.app.vault.adapter as PluginDataAdapter & {
			mkdir?: (path: string) => Promise<void>;
		};
		if (!adapter.write) return;
		const safeFolder = normalizePath(folder);
		await ensureVaultFolder(adapter, safeFolder);
		const targetPath = normalizePath(`${safeFolder}/${filename}`);
		const tempPath = `${targetPath}.tmp-${Date.now()}`;
		const payload = sanitizeLogValue(body);
		await adapter.write(tempPath, payload);
		if (adapter.rename) {
			try {
				await adapter.rename(tempPath, targetPath);
				return;
			} catch {
				await adapter.write(targetPath, payload);
				await adapter.remove?.(tempPath).catch(() => undefined);
				return;
			}
		}
		await adapter.write(targetPath, payload);
		await adapter.remove?.(tempPath).catch(() => undefined);
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

class StaleNotionIdConfirmationModal extends Modal {
	constructor(
		app: App,
		private readonly state: Extract<StaleNotionIdSafetyState, { kind: "requires-stale-id-confirmation" }>,
		private readonly message: string,
		private readonly onDecision: (confirmed: boolean) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Confirm stale notion-id skips" });
		contentEl.createEl("p", { text: this.message });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: `Threshold: more than ${this.state.threshold.count} stale skips or more than ${Math.round(this.state.threshold.ratio * 100)}% of candidate files.`,
		});
		new Setting(contentEl)
			.addButton((button) => button
				.setButtonText("Cancel")
				.onClick(() => {
					this.close();
					this.onDecision(false);
				}))
			.addButton((button) => button
				.setButtonText("I see the stale IDs, proceed anyway")
				.setWarning()
				.onClick(() => {
					this.close();
					this.onDecision(true);
				}));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class PageImportModal extends Modal {
	private input = "";
	private outputFolder = "";

	constructor(
		app: App,
		private readonly plugin: NotionFreezePlugin,
		private readonly onSubmit: (input: string, outputFolder: string) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Import standalone page" });
		new Setting(contentEl)
			.setName("Notion page URL or ID")
			.setDesc("Paste a Notion page link, dashed UUID, or bare 32-character page ID.")
			.addText((text) => text
				.setPlaceholder("https://www.notion.so/... or 32-character page ID")
				.onChange((value) => {
					this.input = value.trim();
				}));
		new Setting(contentEl)
			.setName("Vault folder")
			.setDesc("Only this standalone page will be written here.")
			.addText((text) => text
				.setPlaceholder(this.plugin.settings.defaultOutputFolder || "_relay")
				.onChange((value) => {
					this.outputFolder = value.trim();
				}));
		new Setting(contentEl)
			.addButton((button) => button
				.setButtonText("Cancel")
				.onClick(() => this.close()))
			.addButton((button) => button
				.setButtonText("Import page")
				.setCta()
				.onClick(() => {
					this.close();
					this.onSubmit(this.input, this.outputFolder);
				}));
	}

	onClose(): void {
		this.contentEl.empty();
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
	if (result.backfilled && result.backfilled > 0) {
		msg += `, ${result.backfilled} legacy frontmatter backfilled`;
	}
	msg += ".";
	if (result.warnings && result.warnings.length > 0) {
		msg += "\nWarnings:\n" + result.warnings.join("\n");
	}
	if (result.errors.length > 0) {
		msg += "\nErrors:\n" + result.errors.join("\n");
	}
	return msg;
}

function upsertFrontmatterValue(raw: string, key: string, value: string): string {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n?[\s\S]*)$/);
	const escaped = yamlEscapeString(value);
	if (!match) return `---\n${key}: ${escaped}\n---\n${raw}`;

	const lines = match[1].split(/\r?\n/);
	const keyPattern = new RegExp(`^("${escapeRegExp(key)}"|${escapeRegExp(key)}):\\s*.*$`);
	const index = lines.findIndex((line) => keyPattern.test(line));
	if (index >= 0) {
		lines[index] = `${key}: ${escaped}`;
	} else {
		lines.unshift(`${key}: ${escaped}`);
	}

	return `---\n${lines.join("\n")}\n---${match[2]}`;
}

function yamlEscapeString(value: string): string {
	if (/^[A-Za-z0-9_-]+$/.test(value)) return value;
	return JSON.stringify(value);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parentPath(path: string): string {
	const normalized = normalizePath(path);
	const index = normalized.lastIndexOf("/");
	return index >= 0 ? normalized.slice(0, index) : "";
}

function folderName(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx >= 0 ? path.slice(idx + 1) : path || "Untitled";
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function ensureVaultFolder(
	adapter: PluginDataAdapter & { mkdir?: (path: string) => Promise<void> },
	folder: string
): Promise<void> {
	if (!adapter.mkdir || folder === "/" || folder === ".") return;
	const parts = folder.split("/").filter(Boolean);
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		await adapter.mkdir(current).catch(() => undefined);
	}
}

function sanitizeLogValue(value: string): string {
	return value
		.replace(/(bearer\s+)[a-z0-9._-]+/gi, "$1[redacted]")
		.replace(/(ntn_[a-z0-9_=-]+)/gi, "[redacted-notion-token]")
		.replace(/([?&](?:api_key|token|access_token|auth)=)[^&\s]+/gi, "$1[redacted]");
}

function timestampedFilePrefix(iso: string): string {
	const date = new Date(iso);
	const source = Number.isNaN(date.getTime()) ? iso : date.toISOString();
	return source.replace(/[:.]/g, "-");
}

function safeFileToken(value: string): string {
	return value.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 80) || "row";
}
