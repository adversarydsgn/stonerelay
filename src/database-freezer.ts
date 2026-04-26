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

export async function freshDatabaseImport(
	app: App,
	client: Client,
	databaseId: string,
	outputFolder: string,
	onProgress?: ProgressCallback,
	options: SyncRunOptions = {}
): Promise<DatabaseSyncResult> {
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
	await generateBaseFile(app, dataSource, folderPath, databaseId, entries);

	const total = entries.length;
	let created = 0;
	let updated = 0;
	let failed = 0;
	const errors: string[] = [];

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
	const localFiles = scanLocalFiles(app, db.folderPath);

	const staleEntries: PageObjectResponse[] = [];
	let skippedCount = 0;
	const processedIds = new Set<string>();

	for (const entry of entries) {
		processedIds.add(entry.id);
		const localFile = localFiles.get(entry.id);

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

	// Update .base file (schema may have changed)
	await generateBaseFile(app, dataSource, db.folderPath, db.databaseId, entries, lastSyncedAt);

	// Import only stale entries
	let created = 0;
	let updated = 0;
	let failed = 0;
	const errors: string[] = [];

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
			const localFile = localFiles.get(entry.id);
			if (options.bidirectional && localFile) {
				const decision = decideBidirectionalAction({
					rowId: entry.id,
					notionChanged: true,
					vaultChanged: vaultChangedSince(localFile, options.bidirectional.lastSyncedAt),
					sourceOfTruth: options.bidirectional.sourceOfTruth,
					notionEditedAt: entry.last_edited_time,
					vaultEditedAt: new Date(localFile.stat.mtime).toISOString(),
					notionSnapshot: snapshotNotionPage(entry),
					vaultSnapshot: snapshotVaultFile(app, localFile),
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
	for (const [id, file] of localFiles) {
		if (!processedIds.has(id)) {
			await markAsDeleted(app, file);
			deleted++;
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

function scanLocalFiles(
	app: App,
	folderPath: string
): Map<string, TFile> {
	const map = new Map<string, TFile>();
	const folder = app.vault.getAbstractFileByPath(folderPath);
	if (!(folder instanceof TFolder)) return map;

	for (const child of folder.children) {
		if (!(child instanceof TFile) || child.extension !== "md") continue;
		const cache = app.metadataCache.getFileCache(child);
		const notionId = cache?.frontmatter?.["notion-id"];
		if (notionId) {
			map.set(notionId, child);
		}
	}

	return map;
}

async function markAsDeleted(app: App, file: TFile): Promise<void> {
	const content = await app.vault.read(file);

	// Check if already marked
	if (content.includes("notion-deleted: true")) return;

	// Insert notion-deleted into frontmatter
	if (content.startsWith("---\n")) {
		const endIdx = content.indexOf("\n---", 3);
		if (endIdx !== -1) {
			const before = content.slice(0, endIdx);
			const after = content.slice(endIdx);
			await app.vault.modify(file, before + "\nnotion-deleted: true" + after);
			return;
		}
	}

	// No frontmatter found, add it
	const fm = "---\nnotion-deleted: true\n---\n";
	await app.vault.modify(file, fm + content);
}

async function generateBaseFile(
	app: App,
	dataSource: DataSourceObjectResponse,
	folderPath: string,
	notionId: string,
	rows: PageObjectResponse[] = [],
	lastSyncedAt?: string | null
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
		await app.vault.modify(existingFile, baseContent);
	} else {
		await app.vault.create(basePath, baseContent);
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
