import { DEFAULT_SETTINGS, NotionFreezeSettings, SyncDirection, SyncedDatabase } from "./types";

export type DatabaseInput = Partial<SyncedDatabase> & {
	name?: string;
	databaseId: string;
};

export interface SyncAllResult {
	settings: NotionFreezeSettings;
	ok: number;
	errored: number;
}

export type SyncDatabaseRunner = (
	entry: SyncedDatabase,
	outputFolder: string
) => Promise<void>;

export type SyncMode = "pull" | "push";

export function migrateData(data: Partial<NotionFreezeSettings> | null): NotionFreezeSettings {
	const migrated: NotionFreezeSettings = Object.assign(
		{},
		DEFAULT_SETTINGS,
		data ?? {}
	);

	if (!migrated.schemaVersion || migrated.schemaVersion < 2) {
		migrated.databases = migrated.databases ?? [];
		migrated.schemaVersion = 2;
	}

	migrated.databases = (migrated.databases ?? []).map((entry) =>
		createDatabaseEntry({
			...entry,
			direction: normalizeDirection((entry as Partial<SyncedDatabase>).direction),
			lastPulledAt: (entry as Partial<SyncedDatabase>).lastPulledAt ?? entry.lastSyncedAt ?? null,
			lastPushedAt: (entry as Partial<SyncedDatabase>).lastPushedAt ?? null,
		})
	);
	if (migrated.schemaVersion < 3) {
		migrated.schemaVersion = 3;
	}

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

export function resolveOutputFolder(
	settings: NotionFreezeSettings,
	entry?: Pick<SyncedDatabase, "outputFolder">
): string {
	return (
		entry?.outputFolder?.trim() ||
		settings.defaultOutputFolder?.trim() ||
		"_relay"
	);
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

	for (const entry of enabled) {
		notice?.(`Syncing ${entry.name}...`);
		try {
			await runSync(entry, resolveOutputFolder(nextSettings, entry));
			ok++;
			const now = new Date().toISOString();
			nextSettings = updateDatabase(nextSettings, {
				...entry,
				lastSyncedAt: now,
				lastPulledAt: mode === "pull" ? now : entry.lastPulledAt,
				lastPushedAt: mode === "push" ? now : entry.lastPushedAt,
				lastSyncStatus: "ok",
				lastSyncError: undefined,
			});
		} catch (err) {
			errored++;
			nextSettings = updateDatabase(nextSettings, {
				...entry,
				lastSyncStatus: "error",
				lastSyncError: errorMessage(err),
			});
		}
	}

	notice?.(`Sync complete: ${ok} ok, ${errored} errored.`);
	return { settings: nextSettings, ok, errored };
}

export function createDatabaseEntry(entry: Partial<SyncedDatabase>): SyncedDatabase {
	return {
		id: entry.id || generateId(),
		name: entry.name?.trim() || "Untitled database",
		databaseId: entry.databaseId ? normalizeDatabaseId(entry.databaseId) : "",
		outputFolder: entry.outputFolder?.trim() || "",
		direction: normalizeDirection(entry.direction),
		enabled: entry.enabled ?? true,
		lastSyncedAt: entry.lastSyncedAt ?? null,
		lastSyncStatus: entry.lastSyncStatus ?? "never",
		lastSyncError: entry.lastSyncError,
		lastPulledAt: entry.lastPulledAt ?? entry.lastSyncedAt ?? null,
		lastPushedAt: entry.lastPushedAt ?? null,
	};
}

function shouldRunForMode(direction: SyncDirection, mode: SyncMode): boolean {
	return direction === mode || direction === "bidirectional";
}

function normalizeDirection(direction: unknown): SyncDirection {
	return direction === "push" || direction === "bidirectional" ? direction : "pull";
}

function errorMessage(err: unknown): string {
	return (err instanceof Error ? err.message : String(err)).slice(0, 200);
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
