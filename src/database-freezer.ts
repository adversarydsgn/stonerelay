import { Client } from "@notionhq/client";
import {
	DatabaseObjectResponse,
	DataSourceObjectResponse,
	PageObjectResponse,
} from "@notionhq/client/build/src/api-endpoints";
import { App, normalizePath, TFile, TFolder } from "obsidian";
import { DatabaseSyncResult, ProgressCallback, SyncRunOptions } from "./types";
import { assertNotCancelled, classifyError, commitRow } from "./sync-state";
import { decideBidirectionalAction } from "./conflict-resolution";
import { notionRequest } from "./notion-client";
import { convertRichText } from "./block-converter";
import { writeDatabaseEntry } from "./page-writer";
import { FrozenDatabase } from "./freeze-modal";
import { buildBaseFile, inferDefaultViews } from "./view-inference";
import { modifyAtomic, writeAtomic } from "./atomic-vault-write";
import type { ReservationContext } from "./reservations";

export async function freshDatabaseImport(
	app: App,
	client: Client,
	databaseId: string,
	outputFolder: string,
	onProgress?: ProgressCallback,
	options: SyncRunOptions = {}
): Promise<DatabaseSyncResult> {
	requireReservation(options.context, "fresh database import");
	// Validate database exists
	const database = (await notionRequest(() =>
		client.databases.retrieve({ database_id: databaseId })
	)) as DatabaseObjectResponse;

	const dbTitle = convertRichText(database.title) || "Untitled Database";

	// Check if already synced
	const existingFolder = scanForExistingSync(app, databaseId);
	if (existingFolder) {
		throw new Error(
			`Already synced in folder: ${existingFolder}. Use Re-sync.`
		);
	}

	const safeName = dbTitle.replace(/[\\/:*?"<>|]/g, "-").trim() || "Untitled Database";
	const folderPath = options.nestUnderDbName === false
		? normalizePath(outputFolder)
		: normalizePath(`${outputFolder}/${safeName}`);

	// Get data source
	if (!database.data_sources || database.data_sources.length === 0) {
		throw new Error(
			"This appears to be a linked database, which is not supported by the Notion API."
		);
	}
	const dataSourceId = database.data_sources[0].id;

	const dataSource = (await notionRequest(() =>
		client.dataSources.retrieve({ data_source_id: dataSourceId })
	)) as DataSourceObjectResponse;

	// Create folder
	await ensureFolderExists(app, folderPath);

	// Query all entries
	onProgress?.({ phase: "querying" });
	const entries = await queryAllEntries(client, dataSourceId);

	const total = entries.length;
	let created = 0;
	let updated = 0;
	let failed = 0;
	const errors: string[] = [];

	try {
		await generateBaseFile(app, dataSource, folderPath, databaseId, entries, undefined, options);
	} catch (err) {
		failed++;
		const msg = `Base file ${folderPath}: ${err instanceof Error ? err.message : String(err)}`;
		errors.push(msg);
		options.onRowError?.({
			rowId: `${folderPath}.base`,
			direction: "pull",
			error: msg,
			errorCode: classifyError(msg),
			timestamp: new Date().toISOString(),
		});
	}

	// Import all entries
	let current = 0;
	let skippingUntilCursor = Boolean(options.startAfterRowId);
	for (const entry of entries) {
		if (skippingUntilCursor) {
			if (entry.id === options.startAfterRowId) {
				skippingUntilCursor = false;
			}
			continue;
		}
		if (options.retryRowIds && !options.retryRowIds.includes(entry.id)) continue;
		assertNotCancelled(options.signal);
		current++;
		onProgress?.({ phase: "importing", current, total });

		try {
			const result = await commitRow(entry.id, () =>
				writeDatabaseEntry(app, {
					client,
					page: entry,
					outputFolder: folderPath,
					databaseId,
					context: options.context,
					onAtomicWriteCommitted: options.onAtomicWriteCommitted,
				}),
				options.onRowCommitted
			);

			if (result.status === "created") created++;
			else updated++;
		} catch (err) {
			failed++;
			const msg = `Entry ${entry.id}: ${err instanceof Error ? err.message : String(err)}`;
			errors.push(msg);
			options.onRowError?.({
				rowId: entry.id,
				direction: "pull",
				error: msg,
				errorCode: classifyError(msg),
				timestamp: new Date().toISOString(),
			});
			console.error(`Notion sync: Failed to import entry ${entry.id}:`, err);
		}
	}

	onProgress?.({ phase: "done" });

	return {
		title: dbTitle,
		folderPath,
		total,
		created,
		updated,
		skipped: 0,
		deleted: 0,
		failed,
		errors,
	};
}

export async function refreshDatabase(
	app: App,
	client: Client,
	db: FrozenDatabase,
	lastSyncedAt?: string | null,
	onProgress?: ProgressCallback,
	options: SyncRunOptions = {}
): Promise<DatabaseSyncResult> {
	requireReservation(options.context, "database refresh");
	// Query fresh metadata
	onProgress?.({ phase: "querying" });

	const database = (await notionRequest(() =>
		client.databases.retrieve({ database_id: db.databaseId })
	)) as DatabaseObjectResponse;

	const dbTitle = convertRichText(database.title) || "Untitled Database";

	// Get data source
	if (!database.data_sources || database.data_sources.length === 0) {
		throw new Error(
			"This appears to be a linked database, which is not supported by the Notion API."
		);
	}
	const dataSourceId = database.data_sources[0].id;

	const dataSource = (await notionRequest(() =>
		client.dataSources.retrieve({ data_source_id: dataSourceId })
	)) as DataSourceObjectResponse;

	// Query all entries
	const entries = await queryAllEntries(client, dataSourceId);

	// Diff pass
	onProgress?.({ phase: "diffing" });
	const localFiles = await scanLocalFiles(app, db.folderPath, db.databaseId);

	const staleEntries: PageObjectResponse[] = [];
	const legacyBackfills: Array<{ entry: PageObjectResponse; file: TFile }> = [];
	let skippedCount = 0;
	const processedIds = new Set<string>();

	for (const entry of entries) {
		processedIds.add(entry.id);
		const currentFile = localFiles.files.get(entry.id);
		const legacyFile = localFiles.legacyFiles.get(entry.id);
		if (!currentFile && legacyFile) {
			legacyBackfills.push({ entry, file: legacyFile });
		}
		const localFile = currentFile ?? legacyFile;

		if (!localFile) {
			// New row — not in local vault
			staleEntries.push(entry);
		} else {
			const cache = app.metadataCache.getFileCache(localFile);
			const storedEdited = cache?.frontmatter?.["notion-last-edited"];
			if (!storedEdited || storedEdited !== entry.last_edited_time) {
				staleEntries.push(entry);
			} else {
				skippedCount++;
			}
		}
	}

	const total = entries.length;
	onProgress?.({ phase: "detected", staleCount: staleEntries.length, total });

	// Import only stale entries
	let created = 0;
	let updated = 0;
	let failed = 0;
	const errors: string[] = [];
	const warnings: string[] = [...localFiles.duplicateWarnings];
	let backfilled = 0;

	for (const { entry, file } of legacyBackfills) {
		try {
			await backfillNotionDatabaseId(app, file, db.databaseId, options);
			localFiles.files.set(entry.id, file);
			localFiles.legacyFiles.delete(entry.id);
			backfilled++;
		} catch (err) {
			failed++;
			const msg = `Entry ${entry.id}: failed to backfill notion-database-id: ${err instanceof Error ? err.message : String(err)}`;
			errors.push(msg);
			options.onRowError?.({
				rowId: entry.id,
				direction: "pull",
				error: msg,
				errorCode: classifyError(msg),
				timestamp: new Date().toISOString(),
			});
		}
	}

	// Update .base file (schema may have changed)
	try {
		await generateBaseFile(app, dataSource, db.folderPath, db.databaseId, entries, lastSyncedAt, options);
	} catch (err) {
		failed++;
		const msg = `Base file ${db.folderPath}: ${err instanceof Error ? err.message : String(err)}`;
		errors.push(msg);
		options.onRowError?.({
			rowId: `${db.folderPath}.base`,
			direction: "pull",
			error: msg,
			errorCode: classifyError(msg),
			timestamp: new Date().toISOString(),
		});
	}

	let current = 0;
	let skippingUntilCursor = Boolean(options.startAfterRowId);
	for (const entry of staleEntries) {
		if (skippingUntilCursor) {
			if (entry.id === options.startAfterRowId) {
				skippingUntilCursor = false;
			}
			continue;
		}
		if (options.retryRowIds && !options.retryRowIds.includes(entry.id)) continue;
		assertNotCancelled(options.signal);
		current++;
		onProgress?.({ phase: "importing", current, total: staleEntries.length });

		try {
			const effectiveLocalFile = localFiles.files.get(entry.id);
			if (options.bidirectional && effectiveLocalFile) {
				const decision = decideBidirectionalAction({
					rowId: entry.id,
					notionChanged: true,
					vaultChanged: vaultChangedSince(effectiveLocalFile, options.bidirectional.lastSyncedAt),
					sourceOfTruth: options.bidirectional.sourceOfTruth,
					templaterManaged: options.bidirectional.templaterManaged ?? false,
					notionEditedAt: entry.last_edited_time,
					vaultEditedAt: new Date(effectiveLocalFile.stat.mtime).toISOString(),
					notionSnapshot: snapshotNotionPage(entry),
					vaultSnapshot: snapshotVaultFile(app, effectiveLocalFile),
					detectedAt: new Date().toISOString(),
				});
				if (decision.action === "skip") {
					skippedCount++;
					continue;
				}
				if (decision.action === "conflict" && decision.conflict) {
					options.bidirectional.onConflict?.(decision.conflict);
					skippedCount++;
					continue;
				}
				if (decision.action === "push") {
					skippedCount++;
					continue;
				}
			}
			const result = await commitRow(entry.id, () =>
				writeDatabaseEntry(app, {
					client,
					page: entry,
					outputFolder: db.folderPath,
					databaseId: db.databaseId,
					context: options.context,
					onAtomicWriteCommitted: options.onAtomicWriteCommitted,
				}),
				options.onRowCommitted
			);

			if (result.status === "created") created++;
			else updated++;
		} catch (err) {
			failed++;
			const msg = `Entry ${entry.id}: ${err instanceof Error ? err.message : String(err)}`;
			errors.push(msg);
			options.onRowError?.({
				rowId: entry.id,
				direction: "pull",
				error: msg,
				errorCode: classifyError(msg),
				timestamp: new Date().toISOString(),
			});
			console.error(`Notion sync: Failed to refresh entry ${entry.id}:`, err);
		}
	}

	// Handle deletions: entries in local but not in query
	let deleted = 0;
	for (const [id, file] of localFiles.files) {
		if (!processedIds.has(id)) {
			try {
				await markAsDeleted(app, file, options);
				deleted++;
			} catch (err) {
				failed++;
				const msg = `Entry ${id}: ${err instanceof Error ? err.message : String(err)}`;
				errors.push(msg);
			}
		}
	}

	onProgress?.({ phase: "done" });

	return {
		title: dbTitle,
		folderPath: db.folderPath,
		total,
		created,
		updated,
		skipped: skippedCount,
		deleted,
		failed,
		errors,
		warnings,
		backfilled,
	};
}

function vaultChangedSince(file: TFile, lastSyncedAt?: string | null): boolean {
	if (!lastSyncedAt) return true;
	const lastSynced = Date.parse(lastSyncedAt);
	return Number.isNaN(lastSynced) ? true : file.stat.mtime > lastSynced;
}

function snapshotNotionPage(page: PageObjectResponse): Record<string, unknown> {
	return {
		id: page.id,
		lastEditedTime: page.last_edited_time,
		properties: page.properties,
	};
}

function snapshotVaultFile(app: App, file: TFile): Record<string, unknown> {
	const cache = app.metadataCache.getFileCache(file);
	return {
		path: file.path,
		mtime: file.stat.mtime,
		frontmatter: cache?.frontmatter ?? {},
	};
}

function scanForExistingSync(app: App, databaseId: string): string | null {
	for (const file of app.vault.getMarkdownFiles()) {
		const cache = app.metadataCache.getFileCache(file);
		const dbId = cache?.frontmatter?.["notion-database-id"];
		if (dbId === databaseId) {
			return file.parent?.path || null;
		}
	}
	return null;
}

async function queryAllEntries(
	client: Client,
	dataSourceId: string
): Promise<PageObjectResponse[]> {
	const entries: PageObjectResponse[] = [];
	let cursor: string | undefined = undefined;

	do {
		const response = await notionRequest(() =>
			client.dataSources.query({
				data_source_id: dataSourceId,
				start_cursor: cursor,
				page_size: 100,
			})
		);
		for (const result of response.results) {
			if (result.object === "page" && "properties" in result) {
				entries.push(result);
			}
		}
		cursor = response.has_more
			? (response.next_cursor ?? undefined)
			: undefined;
	} while (cursor);

	return entries;
}

export interface LocalFileScanResult {
	files: Map<string, TFile>;
	legacyFiles: Map<string, TFile>;
	duplicateWarnings: string[];
}

export async function scanLocalFiles(
	app: App,
	folderPath: string,
	databaseId: string
): Promise<LocalFileScanResult> {
	const map = new Map<string, TFile>();
	const legacyFiles = new Map<string, TFile>();
	const duplicates = new Map<string, TFile[]>();
	const folder = app.vault.getAbstractFileByPath(folderPath);
	if (!(folder instanceof TFolder)) return { files: map, legacyFiles, duplicateWarnings: [] };

	for (const child of app.vault.getMarkdownFiles()) {
		if (!pathInsideFolder(child.path, folderPath)) continue;
		const cache = app.metadataCache.getFileCache(child);
		const notionId = cache?.frontmatter?.["notion-id"];
		if (!notionId) continue;
		const notionDatabaseId = cache?.frontmatter?.["notion-database-id"];
		if (notionDatabaseId && String(notionDatabaseId).replace(/-/g, "").toLowerCase() !== databaseId.replace(/-/g, "").toLowerCase()) continue;
		const target = notionDatabaseId ? map : legacyFiles;
		if (target.has(notionId)) {
			duplicates.set(notionId, [...(duplicates.get(notionId) ?? [target.get(notionId)!]), child]);
			continue;
		}
		target.set(notionId, child);
	}

	return {
		files: map,
		legacyFiles,
		duplicateWarnings: [...duplicates.entries()].map(([id, files]) =>
			`DB has ${files.length} local files claiming notion-id ${id}: ${files.map((file) => file.path).join(", ")}. Pull updated only ${files[0].path}.`
		),
	};
}

async function markAsDeleted(app: App, file: TFile, options: SyncRunOptions = {}): Promise<void> {
	const content = await app.vault.read(file);

	// Check if already marked
	if (content.includes("notion-deleted: true")) return;

	// Insert notion-deleted into frontmatter
	if (content.startsWith("---\n")) {
		const endIdx = content.indexOf("\n---", 3);
		if (endIdx !== -1) {
			const before = content.slice(0, endIdx);
			const after = content.slice(endIdx);
			await modifyAtomic(app.vault, file, before + "\nnotion-deleted: true" + after, { onCommitted: options.onAtomicWriteCommitted });
			return;
		}
	}

	// No frontmatter found, add it
	const fm = "---\nnotion-deleted: true\n---\n";
	await modifyAtomic(app.vault, file, fm + content, { onCommitted: options.onAtomicWriteCommitted });
}

async function backfillNotionDatabaseId(app: App, file: TFile, databaseId: string, options: SyncRunOptions = {}): Promise<void> {
	const content = await app.vault.read(file);
	if (content.includes("notion-database-id:")) return;
	if (content.startsWith("---\n")) {
		const endIdx = content.indexOf("\n---", 3);
		if (endIdx !== -1) {
			await modifyAtomic(app.vault, file, `${content.slice(0, endIdx)}\nnotion-database-id: ${databaseId}${content.slice(endIdx)}`, { onCommitted: options.onAtomicWriteCommitted });
			return;
		}
	}
	await modifyAtomic(app.vault, file, `---\nnotion-database-id: ${databaseId}\n---\n${content}`, { onCommitted: options.onAtomicWriteCommitted });
}

async function generateBaseFile(
	app: App,
	dataSource: DataSourceObjectResponse,
	folderPath: string,
	notionId: string,
	rows: PageObjectResponse[] = [],
	lastSyncedAt?: string | null,
	options: SyncRunOptions = {}
): Promise<void> {
	const title = convertRichText(dataSource.title) || "Untitled Database";
	const basePath = normalizePath(`${folderPath}/${title}.base`);

	// Build property order from data source schema
	const order: string[] = [];
	for (const [name, config] of Object.entries(dataSource.properties)) {
		if (config.type === "title") continue;
		order.push(name);
	}

	const existingFile = app.vault.getAbstractFileByPath(basePath);
	if (existingFile instanceof TFile) {
		if (isUserEditedBaseFile(existingFile, lastSyncedAt)) {
			console.log(`Preserving user-edited base file: ${basePath}`);
			return;
		}
	}

	const inferred = inferDefaultViews(rows, dataSource);
	const baseContent = buildBaseFile(inferred, {
		folderPath,
		notionId,
		order,
	});

	if (existingFile instanceof TFile) {
		await modifyAtomic(app.vault, existingFile, baseContent, { onCommitted: options.onAtomicWriteCommitted });
	} else {
		await writeAtomic(app.vault, basePath, baseContent, { onCommitted: options.onAtomicWriteCommitted });
	}
}

function pathInsideFolder(path: string, folderPath: string): boolean {
	const folder = normalizePath(folderPath).replace(/\/+$/, "");
	return path === folder || path.startsWith(`${folder}/`);
}

function requireReservation(context: ReservationContext | undefined, writer: string): void {
	if (!context?.id) {
		throw new Error(`Reservation required before ${writer}.`);
	}
}

function isUserEditedBaseFile(file: TFile, lastSyncedAt?: string | null): boolean {
	if (!lastSyncedAt) return false;
	const lastSyncedTime = Date.parse(lastSyncedAt);
	if (Number.isNaN(lastSyncedTime)) return false;
	return file.stat.mtime > lastSyncedTime;
}

async function ensureFolderExists(app: App, path: string): Promise<void> {
	const normalized = normalizePath(path);
	if (app.vault.getAbstractFileByPath(normalized)) return;

	const parts = normalized.split("/");
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!app.vault.getAbstractFileByPath(current)) {
			await app.vault.createFolder(current);
		}
	}
}
