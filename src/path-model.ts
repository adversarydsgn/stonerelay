import { NotionFreezeSettings, PageSyncEntry, SyncedDatabase } from "./types";

export interface VaultPathValidation {
	ok: boolean;
	path: string;
	error?: string;
}

export interface DatabasePathModel {
	configuredParentFolder: string;
	databaseContentFolder: string;
	existingDiscoveredContentFolder: string | null;
	pushSourceFolder: string;
	pullTargetFolder: string;
	errorLogFolder: string | null;
}

export interface PagePathModel {
	pageParentFolder: string;
	pageFilePath: string | null;
	errorLogFolder: string | null;
}

export function resolveConfiguredParentFolder(
	settings: Pick<NotionFreezeSettings, "defaultOutputFolder">,
	entry?: Pick<SyncedDatabase | PageSyncEntry, "outputFolder">
): string {
	return normalizeVaultFolderPath(
		entry?.outputFolder?.trim() ||
		settings.defaultOutputFolder?.trim() ||
		"_relay"
	);
}

export function resolveDatabaseContentFolder(
	settings: Pick<NotionFreezeSettings, "defaultOutputFolder">,
	entry: Pick<SyncedDatabase, "name" | "outputFolder" | "nest_under_db_name">
): string {
	const parent = resolveConfiguredParentFolder(settings, entry);
	if (!entry.nest_under_db_name) return parent;
	return normalizeVaultFolderPath(`${parent}/${safeFolderName(entry.name.trim() || "Untitled Database")}`);
}

export function resolveDatabasePathModel(
	settings: Pick<NotionFreezeSettings, "defaultOutputFolder" | "defaultErrorLogFolder">,
	entry: Pick<SyncedDatabase, "name" | "outputFolder" | "errorLogFolder" | "nest_under_db_name">,
	options: { discoveredContentFolder?: string | null } = {}
): DatabasePathModel {
	const configuredParentFolder = resolveConfiguredParentFolder(settings, entry);
	const databaseContentFolder = resolveDatabaseContentFolder(settings, entry);
	const existingDiscoveredContentFolder = options.discoveredContentFolder
		? normalizeVaultFolderPath(options.discoveredContentFolder)
		: null;
	const actualContentFolder = existingDiscoveredContentFolder ?? databaseContentFolder;
	return {
		configuredParentFolder,
		databaseContentFolder,
		existingDiscoveredContentFolder,
		pushSourceFolder: actualContentFolder,
		pullTargetFolder: actualContentFolder,
		errorLogFolder: resolveErrorLogFolder(settings, entry),
	};
}

export function resolvePagePathModel(
	settings: Pick<NotionFreezeSettings, "defaultOutputFolder" | "defaultErrorLogFolder">,
	entry: Pick<PageSyncEntry, "outputFolder" | "errorLogFolder" | "lastFilePath">
): PagePathModel {
	return {
		pageParentFolder: resolveConfiguredParentFolder(settings, entry),
		pageFilePath: entry.lastFilePath ? normalizeVaultFilePath(entry.lastFilePath) : null,
		errorLogFolder: resolveErrorLogFolder(settings, entry),
	};
}

export function resolveErrorLogFolder(
	settings: Pick<NotionFreezeSettings, "defaultErrorLogFolder">,
	entry?: Pick<SyncedDatabase | PageSyncEntry, "errorLogFolder">
): string | null {
	const folder = entry?.errorLogFolder?.trim() || settings.defaultErrorLogFolder?.trim();
	return folder ? normalizeVaultFolderPath(folder) : null;
}

export function validateVaultFolderPath(path: string): VaultPathValidation {
	const normalized = normalizeVaultFolderPath(path);
	if (!normalized) {
		return { ok: false, path: normalized, error: "Folder path is empty." };
	}
	if (isAbsoluteVaultPath(path)) {
		return { ok: false, path: normalized, error: "Folder path must be relative to the vault." };
	}
	if (hasTraversal(normalized)) {
		return { ok: false, path: normalized, error: "Folder path cannot contain ../ traversal." };
	}
	return { ok: true, path: normalized };
}

export function isSafeVaultRelativePath(path: string): boolean {
	return validateVaultFolderPath(path).ok;
}

export function normalizeVaultFolderPath(path: string): string {
	return path
		.trim()
		.replace(/\\/g, "/")
		.replace(/\/+/g, "/")
		.replace(/^\.\/+/, "")
		.replace(/\/+$/g, "");
}

export function normalizeVaultFilePath(path: string): string {
	return path
		.trim()
		.replace(/\\/g, "/")
		.replace(/\/+/g, "/")
		.replace(/^\.\/+/, "");
}

export function normalizeForCompare(path: string): string {
	return normalizeVaultFilePath(path).replace(/^\/+|\/+$/g, "").toLowerCase();
}

export function pathStartsWith(path: string, folder: string): boolean {
	const normalizedPath = normalizeForCompare(path);
	const normalizedFolder = normalizeForCompare(folder);
	return Boolean(normalizedFolder) && (normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}/`));
}

export function pathsOverlap(firstFolder: string, secondFolder: string): boolean {
	const first = normalizeForCompare(firstFolder);
	const second = normalizeForCompare(secondFolder);
	return first === second || first.startsWith(`${second}/`) || second.startsWith(`${first}/`);
}

export function safeFolderName(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, "-").trim() || "Untitled Database";
}

function isAbsoluteVaultPath(path: string): boolean {
	const trimmed = path.trim();
	return trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed);
}

function hasTraversal(path: string): boolean {
	return path.split("/").some((part) => part === "..");
}
