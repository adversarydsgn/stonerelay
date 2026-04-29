import { normalizePath } from "obsidian";
import { SyncedDatabase } from "./types";
import { PluginDataAdapter } from "./plugin-data";
import { pathStartsWith, resolveDatabasePathModel } from "./path-model";
import { extractUniqueId } from "./notion-property-utils";

export interface VaultCanonicalLockfileState {
	nextId: number | null;
	nextIdRaw: string | null;
	nextIdPresent: boolean;
	nextIdParseError: string | null;
	lockPresent: boolean;
	nextIdMtime: number | null;
}

export interface VaultCanonicalDiagnosticsRow {
	entryId: string;
	name: string;
	mirrorProperty: string | null;
	nextIdValue: number | null;
	nextIdPresent: boolean;
	nextIdParseError: string | null;
	lockPresent: boolean;
	nextIdMtime: number | null;
	lastObservedUniqueIdMax: number | null;
	sequenceLag: boolean;
	awaitingStampCount: number;
	midBootstrap: boolean;
}

export interface VaultCanonicalAdapter extends PluginDataAdapter {
	stat?: (path: string) => Promise<{ mtime?: number; mtimeMs?: number } | null>;
}

export function canonicalIdProperty(entry: Pick<SyncedDatabase, "canonical_id_property">): string | null {
	const value = entry.canonical_id_property?.trim();
	return value ? value : null;
}

export function vaultCanonicalModeActive(entry: Pick<SyncedDatabase, "canonical_id_property">, state: Pick<VaultCanonicalLockfileState, "nextIdPresent">): boolean {
	return Boolean(canonicalIdProperty(entry) && state.nextIdPresent);
}

export async function readVaultCanonicalState(
	adapter: VaultCanonicalAdapter | undefined,
	folderPath: string
): Promise<VaultCanonicalLockfileState> {
	const nextPath = lockfilePath(folderPath, ".next-id");
	const lockPath = lockfilePath(folderPath, ".next-id.lock");
	const raw = adapter?.read ? await adapter.read(nextPath).catch(() => null) : null;
	const parsed = parseNextId(raw);
	const lockPresent = adapter?.read ? await adapter.read(lockPath).then(() => true, () => false) : false;
	const stat = adapter?.stat ? await adapter.stat(nextPath).catch(() => null) : null;
	return {
		nextId: parsed.value,
		nextIdRaw: raw,
		nextIdPresent: raw !== null,
		nextIdParseError: parsed.error,
		lockPresent,
		nextIdMtime: stat?.mtimeMs ?? stat?.mtime ?? null,
	};
}

export function parseNextId(raw: string | null | undefined): { value: number | null; error: string | null } {
	if (raw === null || raw === undefined) return { value: null, error: null };
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) return { value: null, error: "Expected bare integer .next-id value." };
	return { value: Number(trimmed), error: null };
}

export function lockfilePath(folderPath: string, fileName: ".next-id" | ".next-id.lock"): string {
	return normalizePath(`${folderPath}/${fileName}`);
}

export function isForbiddenLockfileWritePath(targetPath: string): boolean {
	const normalized = normalizePath(targetPath);
	return normalized.endsWith("/.next-id") || normalized.endsWith("/.next-id.lock") || normalized === ".next-id" || normalized === ".next-id.lock";
}

export function extractCanonicalMirrorId(page: unknown, propertyName: string | null | undefined): string | null {
	if (!propertyName || !page || typeof page !== "object") return null;
	const prop = ((page as { properties?: Record<string, unknown> }).properties ?? {})[propertyName];
	if (!prop || typeof prop !== "object") return null;
	const typed = prop as { type?: string; rich_text?: Array<{ plain_text?: string; text?: { content?: string } }>; title?: Array<{ plain_text?: string; text?: { content?: string } }>; unique_id?: unknown };
	if (typed.type === "rich_text") return richTextPlainText(typed.rich_text);
	if (typed.type === "title") return richTextPlainText(typed.title);
	if (typed.type === "unique_id") return extractUniqueId(prop);
	return null;
}

export function extractUniqueIdNumber(page: unknown): number | null {
	if (!page || typeof page !== "object") return null;
	const properties = (page as { properties?: Record<string, unknown> }).properties ?? {};
	for (const prop of Object.values(properties)) {
		if (!prop || typeof prop !== "object") continue;
		const typed = prop as { type?: unknown; unique_id?: { number?: unknown } | null };
		if (typed.type === "unique_id" && typeof typed.unique_id?.number === "number") {
			return typed.unique_id.number;
		}
	}
	return null;
}

export function maxUniqueIdNumber(pages: unknown[]): number | null {
	let max: number | null = null;
	for (const page of pages) {
		const value = extractUniqueIdNumber(page);
		if (value === null) continue;
		max = max === null ? value : Math.max(max, value);
	}
	return max;
}

export function vaultCanonicalIdFromProps(props: Record<string, unknown>): string | null {
	const value = props["ID"];
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function buildVaultCanonicalDiagnosticsRow(input: {
	entry: SyncedDatabase;
	folderPath: string;
	state: VaultCanonicalLockfileState;
	awaitingStampCount: number;
}): VaultCanonicalDiagnosticsRow | null {
	const mirrorProperty = canonicalIdProperty(input.entry);
	if (!mirrorProperty && !input.state.nextIdPresent) return null;
	const lastObserved = input.entry.last_observed_unique_id_max ?? null;
	return {
		entryId: input.entry.id,
		name: input.entry.name,
		mirrorProperty,
		nextIdValue: input.state.nextId,
		nextIdPresent: input.state.nextIdPresent,
		nextIdParseError: input.state.nextIdParseError,
		lockPresent: input.state.lockPresent,
		nextIdMtime: input.state.nextIdMtime,
		lastObservedUniqueIdMax: lastObserved,
		sequenceLag: lastObserved !== null && input.state.nextId !== null && lastObserved >= input.state.nextId,
		awaitingStampCount: input.awaitingStampCount,
		midBootstrap: input.state.nextIdPresent && !mirrorProperty,
	};
}

export function countAwaitingIdStamp(
	files: Array<{ path: string; frontmatter: Record<string, unknown> }>,
	folderPath: string
): number {
	return files.filter((file) =>
		pathStartsWith(file.path, folderPath) &&
		typeof file.frontmatter["notion-id"] === "string" &&
		typeof file.frontmatter["ID"] !== "string"
	).length;
}

export function folderForEntry(settings: Parameters<typeof resolveDatabasePathModel>[0], entry: SyncedDatabase): string {
	return resolveDatabasePathModel(settings, entry).pushSourceFolder;
}

function richTextPlainText(values: Array<{ plain_text?: string; text?: { content?: string } }> | undefined): string | null {
	if (!Array.isArray(values)) return null;
	const text = values.map((item) => item.plain_text ?? item.text?.content ?? "").join("").trim();
	return text || null;
}
