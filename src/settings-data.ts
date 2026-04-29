import { promises as fs } from "fs";
import { dirname } from "path";
import { DEFAULT_SETTINGS, NotionFreezeSettings, PageSyncEntry, SyncDirection, SyncError, SyncGroup, SyncedDatabase, AutoSyncOverride } from "./types";
import { applyPhaseTransition } from "./sync-state";
import {
	resolveConfiguredParentFolder,
	resolveDatabaseContentFolder as resolveCentralDatabaseContentFolder,
	resolveErrorLogFolder as resolveCentralErrorLogFolder,
} from "./path-model";

export type DatabaseInput = Partial<SyncedDatabase> & {
	name?: string;
	databaseId: string;
};

export type PageInput = Partial<PageSyncEntry> & {
	name?: string;
	pageId: string;
};

export interface SyncAllResult {
	settings: NotionFreezeSettings;
	ok: number;
	errored: number;
	cancelled?: number;
}

export type SyncDatabaseRunner = (
	entry: SyncedDatabase,
	outputFolder: string
) => Promise<{ failed: number; errors: string[] } | void>;

export type SyncMode = "pull" | "push";

export function migrateData(data: Partial<NotionFreezeSettings> | null): NotionFreezeSettings {
	const migrated: NotionFreezeSettings = Object.assign(
		{},
		DEFAULT_SETTINGS,
		data ?? {}
	);
	migrated.defaultErrorLogFolder = migrated.defaultErrorLogFolder ?? "";
	migrated.pages = migrated.pages ?? [];
	migrated.groups = migrated.groups ?? [];
	migrated.autoSyncEnabled = migrated.autoSyncEnabled ?? false;
	migrated.autoSyncDatabasesByDefault = migrated.autoSyncDatabasesByDefault ?? false;
	migrated.autoSyncPagesByDefault = migrated.autoSyncPagesByDefault ?? false;

	if (!migrated.schemaVersion || migrated.schemaVersion < 2) {
		migrated.databases = migrated.databases ?? [];
		migrated.schemaVersion = 2;
	}

	migrated.pendingConflicts = migrated.pendingConflicts ?? [];
	migrated.active_reservations = [];
	migrated.databases = (migrated.databases ?? []).map((entry) => {
		const direction = normalizeDirection((entry as Partial<SyncedDatabase>).direction);
		const lastSyncedAt = entry.lastSyncedAt ?? null;
		return createDatabaseEntry({
			...entry,
			direction,
			lastPulledAt: (entry as Partial<SyncedDatabase>).lastPulledAt ?? lastSyncedAt,
			lastPushedAt: (entry as Partial<SyncedDatabase>).lastPushedAt ?? null,
			current_phase: entry.current_phase ?? (lastSyncedAt ? "phase_2" : "phase_1"),
			initial_seed_direction: entry.initial_seed_direction ?? (lastSyncedAt ? initialSeedDirection(direction) : null),
			source_of_truth: entry.source_of_truth ?? (lastSyncedAt ? sourceOfTruthForLegacy(direction) : null),
			templater_managed: entry.templater_managed ?? false,
			first_sync_completed_at: entry.first_sync_completed_at ?? lastSyncedAt,
			nest_under_db_name: entry.nest_under_db_name ?? true,
			current_sync_id: null,
			lastCommittedRowId: entry.lastCommittedRowId ?? null,
			lastSyncErrors: entry.lastSyncErrors ?? [],
			strictFrontmatterSchema: entry.strictFrontmatterSchema ?? false,
			errorLogFolder: entry.errorLogFolder ?? "",
			groupId: entry.groupId ?? null,
			autoSync: normalizeAutoSyncOverride(entry.autoSync),
		});
	});
	migrated.pages = (migrated.pages ?? []).map((entry) => createPageEntry(entry));
	migrated.groups = (migrated.groups ?? []).map((group) => createGroup(group));
	if (migrated.schemaVersion < 3) {
		migrated.schemaVersion = 3;
	}
	if (migrated.schemaVersion < 4) {
		migrated.schemaVersion = 4;
	}
	if (migrated.schemaVersion < 5) {
		migrated.schemaVersion = 5;
	}
	if (migrated.schemaVersion < 6) {
		migrated.schemaVersion = 6;
	}
	if (migrated.schemaVersion < 7) {
		migrated.databases = (migrated.databases ?? []).map((entry) => ({
			...entry,
			templater_managed: entry.templater_managed ?? false,
		}));
		migrated.schemaVersion = 7;
	}
	migrated.active_reservations = [];

	return migrated;
}

export function addDatabase(
	settings: NotionFreezeSettings,
	entry: DatabaseInput
): NotionFreezeSettings {
	return {
		...settings,
		databases: [
			...settings.databases,
			createDatabaseEntry(entry),
		],
	};
}

export function updateDatabase(
	settings: NotionFreezeSettings,
	entry: SyncedDatabase
): NotionFreezeSettings {
	return {
		...settings,
		databases: settings.databases.map((db) =>
			db.id === entry.id ? createDatabaseEntry(entry) : db
		),
	};
}

export function removeDatabase(
	settings: NotionFreezeSettings,
	id: string
): NotionFreezeSettings {
	return {
		...settings,
		databases: settings.databases.filter((db) => db.id !== id),
	};
}

export function addPage(
	settings: NotionFreezeSettings,
	entry: PageInput
): NotionFreezeSettings {
	return {
		...settings,
		pages: [
			...settings.pages,
			createPageEntry(entry),
		],
	};
}

export function updatePage(
	settings: NotionFreezeSettings,
	entry: PageSyncEntry
): NotionFreezeSettings {
	return {
		...settings,
		pages: settings.pages.map((page) =>
			page.id === entry.id ? createPageEntry(entry) : page
		),
	};
}

export function removePage(
	settings: NotionFreezeSettings,
	id: string
): NotionFreezeSettings {
	return {
		...settings,
		pages: settings.pages.filter((page) => page.id !== id),
	};
}

export function addGroup(
	settings: NotionFreezeSettings,
	name: string
): NotionFreezeSettings {
	return {
		...settings,
		groups: [
			...settings.groups,
			createGroup({ name }),
		],
	};
}

export function updateGroup(
	settings: NotionFreezeSettings,
	group: SyncGroup
): NotionFreezeSettings {
	return {
		...settings,
		groups: settings.groups.map((candidate) =>
			candidate.id === group.id ? createGroup(group) : candidate
		),
	};
}

export function removeGroup(
	settings: NotionFreezeSettings,
	groupId: string
): NotionFreezeSettings {
	return {
		...settings,
		groups: settings.groups.filter((group) => group.id !== groupId),
		databases: settings.databases.map((entry) =>
			entry.groupId === groupId ? { ...entry, groupId: null } : entry
		),
		pages: settings.pages.map((entry) =>
			entry.groupId === groupId ? { ...entry, groupId: null } : entry
		),
	};
}

export function resolveOutputFolder(
	settings: NotionFreezeSettings,
	entry?: Pick<SyncedDatabase | PageSyncEntry, "outputFolder">
): string {
	return resolveConfiguredParentFolder(settings, entry);
}

export function resolveDatabaseContentFolder(
	settings: NotionFreezeSettings,
	entry: Pick<SyncedDatabase, "name" | "outputFolder" | "nest_under_db_name">
): string {
	return resolveCentralDatabaseContentFolder(settings, entry);
}

export function sharedOutputFolderDatabases(
	settings: Pick<NotionFreezeSettings, "databases" | "defaultOutputFolder">,
	entry: Pick<SyncedDatabase, "id" | "outputFolder">
): SyncedDatabase[] {
	const folder = normalizeFolder(resolveOutputFolder(settings as NotionFreezeSettings, entry));
	if (!folder) return [];
	return settings.databases.filter((candidate) =>
		candidate.id !== entry.id &&
		normalizeFolder(resolveOutputFolder(settings as NotionFreezeSettings, candidate)) === folder
	);
}

export function resolveErrorLogFolder(
	settings: Pick<NotionFreezeSettings, "defaultErrorLogFolder">,
	entry?: Pick<SyncedDatabase | PageSyncEntry, "errorLogFolder">
): string | null {
	return resolveCentralErrorLogFolder(settings, entry);
}

export function effectiveAutoSyncEnabled(
	settings: Pick<NotionFreezeSettings, "autoSyncEnabled" | "autoSyncDatabasesByDefault" | "autoSyncPagesByDefault">,
	entry: Pick<SyncedDatabase, "autoSync"> | Pick<PageSyncEntry, "autoSync" | "type">,
	entryType: "database" | "page" = "database"
): boolean {
	if (!settings.autoSyncEnabled) return false;
	if (entry.autoSync === "off") return false;
	if (entry.autoSync === "on") return true;
	return entryType === "page"
		? settings.autoSyncPagesByDefault
		: settings.autoSyncDatabasesByDefault;
}

export async function syncAll(
	settings: NotionFreezeSettings,
	runSync: SyncDatabaseRunner,
	notice?: (message: string) => void,
	mode: SyncMode = "pull"
): Promise<SyncAllResult> {
	const enabled = settings.databases.filter((entry) =>
		entry.enabled === true && shouldRunForMode(entry.direction, mode)
	);
	if (enabled.length === 0) {
		notice?.(`No enabled databases to ${mode}.`);
		return { settings, ok: 0, errored: 0 };
	}

	let nextSettings = settings;
	let ok = 0;
	let errored = 0;
	let cancelled = 0;

	const outcomes = await Promise.all(enabled.map(async (entry) => {
		notice?.(`Syncing ${entry.name}...`);
		try {
			const result = await runSync(entry, resolveOutputFolder(settings, entry));
			return { entry, result };
		} catch (err) {
			return { entry, error: err };
		}
	}));

	for (const outcome of outcomes) {
		const { entry } = outcome;
		if ("error" in outcome) {
			if (isCancelledError(outcome.error)) {
				cancelled++;
				nextSettings = updateDatabase(nextSettings, {
					...entry,
					lastSyncStatus: "cancelled",
					lastSyncError: undefined,
				});
				continue;
			}
			errored++;
			nextSettings = updateDatabase(nextSettings, {
				...entry,
				lastSyncStatus: "error",
				lastSyncError: errorMessage(outcome.error),
			});
			continue;
		}

		ok++;
		const now = new Date().toISOString();
		const result = outcome.result;
		const errors = result
			? syncErrorObjects(result.errors, mode, now)
			: [];
		const status = result && (result.failed > 0 || errors.length > 0) ? "partial" : "ok";
		nextSettings = updateDatabase(nextSettings, applyPhaseTransition({
			...entry,
			lastSyncedAt: now,
			lastPulledAt: mode === "pull" ? now : entry.lastPulledAt,
			lastPushedAt: mode === "push" ? now : entry.lastPushedAt,
			lastSyncStatus: status,
			lastSyncError: errors.length > 0 ? errors.map((error) => error.error).join("\n").slice(0, 200) : undefined,
			lastSyncErrors: errors,
		}, status, errors, "full", now));
	}

	notice?.(`Sync complete: ${ok} ok, ${errored} errored${cancelled > 0 ? `, ${cancelled} cancelled` : ""}.`);
	return { settings: nextSettings, ok, errored, cancelled };
}

export function createDatabaseEntry(entry: Partial<SyncedDatabase>): SyncedDatabase {
	return {
		id: entry.id || generateId(),
		name: entry.name?.trim() || "Untitled database",
		databaseId: entry.databaseId ? normalizeDatabaseId(entry.databaseId) : "",
		outputFolder: entry.outputFolder?.trim() || "",
		errorLogFolder: entry.errorLogFolder?.trim() || "",
		groupId: entry.groupId ?? null,
		autoSync: normalizeAutoSyncOverride(entry.autoSync),
		direction: normalizeDirection(entry.direction),
		enabled: entry.enabled ?? true,
		lastSyncedAt: entry.lastSyncedAt ?? null,
		lastSyncStatus: entry.lastSyncStatus ?? "never",
		lastSyncError: entry.lastSyncError,
		lastPulledAt: entry.lastPulledAt ?? entry.lastSyncedAt ?? null,
		lastPushedAt: entry.lastPushedAt ?? null,
		current_phase: entry.current_phase ?? (entry.lastSyncedAt ? "phase_2" : "phase_1"),
		initial_seed_direction: entry.initial_seed_direction ?? null,
		source_of_truth: entry.source_of_truth ?? null,
		templater_managed: entry.templater_managed ?? false,
		first_sync_completed_at: entry.first_sync_completed_at ?? null,
		nest_under_db_name: entry.nest_under_db_name ?? true,
			current_sync_id: entry.current_sync_id ?? null,
			lastCommittedRowId: entry.lastCommittedRowId ?? null,
			lastSyncErrors: entry.lastSyncErrors ?? [],
			strictFrontmatterSchema: entry.strictFrontmatterSchema ?? false,
		};
	}

export function createPageEntry(entry: Partial<PageSyncEntry>): PageSyncEntry {
	return {
		id: entry.id || generateId(),
		type: "page",
		name: entry.name?.trim() || "Untitled page",
		pageId: entry.pageId ? normalizeNotionPageId(entry.pageId) : "",
		outputFolder: entry.outputFolder?.trim() || "",
		errorLogFolder: entry.errorLogFolder?.trim() || "",
		groupId: entry.groupId ?? null,
		enabled: entry.enabled ?? true,
		autoSync: normalizeAutoSyncOverride(entry.autoSync),
		lastSyncedAt: entry.lastSyncedAt ?? null,
		lastSyncStatus: entry.lastSyncStatus ?? "never",
		lastSyncError: entry.lastSyncError,
		current_sync_id: entry.current_sync_id ?? null,
		lastFilePath: entry.lastFilePath ?? null,
	};
}

export function createGroup(group: Partial<SyncGroup>): SyncGroup {
	return {
		id: group.id || generateId(),
		name: group.name?.trim() || "Untitled group",
		collapsed: group.collapsed ?? false,
	};
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await fs.mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
	const payload = `${JSON.stringify(value, null, 2)}\n`;
	await fs.writeFile(tempPath, payload, "utf8");
	await fs.rename(tempPath, path);
}

function shouldRunForMode(direction: SyncDirection, mode: SyncMode): boolean {
	return direction === mode || direction === "bidirectional";
}

function normalizeFolder(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
}

function normalizeDirection(direction: unknown): SyncDirection {
	return direction === "push" || direction === "bidirectional" ? direction : "pull";
}

function normalizeAutoSyncOverride(value: unknown): AutoSyncOverride {
	return value === "on" || value === "off" ? value : "inherit";
}

function initialSeedDirection(direction: SyncDirection): "pull" | "push" {
	return direction === "push" ? "push" : "pull";
}

function sourceOfTruthForLegacy(direction: SyncDirection): "notion" | "obsidian" {
	return direction === "push" ? "obsidian" : "notion";
}

function errorMessage(err: unknown): string {
	return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

function isCancelledError(err: unknown): boolean {
	return err instanceof Error && (err.name === "ReservationCancelledError" || err.name === "SyncCancelled");
}

function syncErrorObjects(messages: string[], mode: SyncMode, timestamp: string): SyncError[] {
	return messages.map((message) => ({
		rowId: message.split(":")[0]?.trim() || "unknown",
		direction: mode,
		error: message,
		timestamp,
	}));
}

function generateId(): string {
	if (globalThis.crypto?.randomUUID) {
		return globalThis.crypto.randomUUID();
	}
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
		const rand = Math.floor(Math.random() * 16);
		const value = char === "x" ? rand : (rand & 0x3) | 0x8;
		return value.toString(16);
	});
}

function normalizeDatabaseId(input: string): string {
	const hex = input.trim().replace(/-/g, "");
	if (!/^[a-f0-9]{32}$/i.test(hex)) {
		throw new Error(`Invalid Notion ID: ${input}`);
	}
	return hex.toLowerCase();
}

function normalizeNotionPageId(input: string): string {
	const hex = input.trim().replace(/-/g, "");
	if (!/^[a-f0-9]{32}$/i.test(hex)) {
		throw new Error(`Invalid Notion page ID: ${input}`);
	}
	return hex.toLowerCase();
}
