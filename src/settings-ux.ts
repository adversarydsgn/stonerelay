import { Client } from "@notionhq/client";
import { AutoSyncOverride, Conflict, NotionFreezeSettings, PageSyncEntry, SyncDirection, SyncError, SyncGroup, SyncedDatabase } from "./types";
import { effectiveAutoSyncEnabled, resolveDatabaseContentFolder } from "./settings-data";

export interface DatabaseMetadata {
	title: string;
	propertyCount?: number;
	rowCount?: string;
	rowCountApproximate?: boolean;
}

export const DIRECTION_LABELS: Record<SyncDirection, string> = {
	pull: "Pull (Notion is source — vault gets seeded)",
	push: "Push (Vault is source — Notion gets seeded)",
	bidirectional: "Bidirectional (pegged partnership)",
};

export const DIRECTION_OPTION_ORDER: SyncDirection[] = ["pull", "push", "bidirectional"];

export const DIRECTION_SECTION_HELPER =
	"Pull seeds vault from Notion. Push seeds Notion from vault. Bidirectional pegs both sides and surfaces conflicts for review.";

export const DIRECTION_HELPER =
	"Bidirectional pegs both sides. Conflicts are surfaced for review instead of silently overwritten.";

export const PREVIEW_PLACEHOLDER =
	"Click Test connection to preview row counts and next-sync action.";

export const EMPTY_PUSH_WARNING =
	"⚠️ Vault folder is empty. A Push will not create any Notion rows. Did you mean Pull?";

export const EMPTY_PULL_WARNING =
	"⚠️ Notion DB has 0 rows. A Pull will not create any vault files. Did you mean Push?";

export interface VaultFolderStats {
	path: string;
	exists: boolean;
	markdownFiles: number;
}

export interface ConnectionPreviewInput {
	direction: SyncDirection;
	metadata: DatabaseMetadata;
	vault: VaultFolderStats;
}

export interface PreviewRow {
	icon: "✓" | "⚠" | "→";
	text: string;
}

export interface DatabaseDirectionCounts {
	pegged: number;
	pullOnly: number;
	pushOnly: number;
}

export interface SyncHistoryTooltip {
	lastSyncedAt: string | null;
	lastPulledAt: string | null;
	lastPushedAt: string | null;
	lastStatus: string;
	lastError?: string;
}

export interface GroupedSyncEntries {
	group: SyncGroup | null;
	databases: SyncedDatabase[];
	pages: PageSyncEntry[];
}

export interface FolderScopeWarning {
	sharedCount: number;
	message: string;
}

export interface SyncErrorSummary {
	failures: number;
	warnings: number;
	label: string;
}

export const AUTO_SYNC_OVERRIDE_LABELS: Record<AutoSyncOverride, string> = {
	inherit: "Auto-sync: Inherit",
	on: "Auto-sync: On",
	off: "Auto-sync: Off",
};

export type FetchDatabaseMetadataResult =
	| { ok: true; metadata: DatabaseMetadata }
	| { ok: false; error: string };

type MetadataClient = Pick<Client, "databases" | "dataSources">;

/**
 * Extracts and normalizes a Notion database ID from a Notion URL, dashed UUID, or bare 32-char hex string.
 */
export function parseNotionDbId(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;

	let candidate = trimmed;
	if (trimmed.includes("notion.so/")) {
		const withoutQuery = trimmed.split("?")[0];
		const segment = withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1);
		const match = segment.match(/([a-f0-9]{32})$/i);
		if (!match) return null;
		candidate = match[1];
	}

	const hex = candidate.replace(/-/g, "");
	return /^[a-f0-9]{32}$/i.test(hex) ? hex.toLowerCase() : null;
}

/**
 * Extracts and normalizes a Notion page ID from a Notion URL, dashed UUID, or bare 32-char hex string.
 */
export function parseNotionPageId(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;

	let candidate = trimmed;
	if (/^https?:\/\//i.test(trimmed)) {
		try {
			const url = new URL(trimmed);
			if (!url.hostname.endsWith("notion.so") && !url.hostname.endsWith("notion.site")) return null;
			const segment = url.pathname.split("/").filter(Boolean).pop() ?? "";
			const match = segment.match(/([a-f0-9]{32})$/i);
			if (!match) return null;
			candidate = match[1];
		} catch {
			return null;
		}
	}

	const hex = candidate.replace(/-/g, "");
	return /^[a-f0-9]{32}$/i.test(hex) ? hex.toLowerCase() : null;
}

/**
 * Converts a database title into a short vault-folder-safe slug.
 */
export function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/g, "");
}

/**
 * Trims pasted API keys while preserving meaningful internal characters.
 */
export function trimApiKey(value: string): string {
	return value.trim();
}

export function shouldAutoFillDatabaseName(
	currentName: string,
	nameTouched: boolean,
	isNewEntry: boolean
): boolean {
	if (nameTouched) return false;
	const trimmed = currentName.trim();
	return trimmed.length === 0 || (isNewEntry && trimmed === "Untitled database");
}

export function vaultFolderHelper(direction: SyncDirection): string {
	if (direction === "push") {
		return "Vault folder containing markdown files to push to Notion. Files in this folder will be uploaded as Notion rows.";
	}
	if (direction === "bidirectional") {
		return "Vault folder used for both directions. Files here will be both written-to (from Notion pulls) and read-from (for Notion pushes).";
	}
	return "Vault folder where pulled notes will be created. Existing files with same name will be overwritten.";
}

export function buildConnectionPreview(input: ConnectionPreviewInput): string {
	return buildConnectionPreviewRows(input)
		.map((row) => `${row.icon} ${row.text}`)
		.join("\n");
}

export function buildConnectionPreviewRows(input: ConnectionPreviewInput): PreviewRow[] {
	const { direction, metadata, vault } = input;
	const details: string[] = [];
	if (metadata.propertyCount !== undefined) {
		details.push(`${metadata.propertyCount} properties`);
	}
	if (metadata.rowCount !== undefined) {
		details.push(`${metadata.rowCount} rows`);
	}

	const connected = details.length > 0
		? `✓ Connected to "${metadata.title}" · ${details.join(" · ")}`
		: `✓ Connected to "${metadata.title}"`;
	const folderState = vault.exists ? "exists" : "does not exist";
	const folder = `Vault folder \`${displayFolderPath(vault.path)}\` ${folderState}, ${vault.markdownFiles} .md files`;
	return [
		{ icon: "✓", text: connected.slice(2) },
		{ icon: vault.exists ? "✓" : "⚠", text: folder },
		{ icon: "→", text: directionPreviewLine(direction, metadata.rowCount, vault.markdownFiles) },
	];
}

export function formWarnings(direction: SyncDirection, metadata: DatabaseMetadata | undefined, vault: VaultFolderStats): string[] {
	const warnings: string[] = [];
	if (direction === "push" && vault.markdownFiles === 0) {
		warnings.push(EMPTY_PUSH_WARNING);
	}
	if (direction === "pull" && metadata?.rowCount === "0") {
		warnings.push(EMPTY_PULL_WARNING);
	}
	return warnings;
}

export function shouldConfirmDirectionChange(
	previousDirection: SyncDirection,
	nextDirection: SyncDirection,
	lastSyncedAt: string | null
): boolean {
	return Boolean(lastSyncedAt && previousDirection !== nextDirection);
}

export function directionChangeWarning(previousDirection: SyncDirection, nextDirection: SyncDirection): string {
	if (previousDirection === "pull" && nextDirection === "push") {
		return "Obsidian becomes authoritative. Notion-side changes may be overwritten on the next push.";
	}
	if (previousDirection === "push" && nextDirection === "bidirectional") {
		return "Bidirectional partnership will be active. Conflicts may surface when both sides change.";
	}
	if (previousDirection === "bidirectional" && nextDirection === "pull") {
		return "Obsidian-side changes since the last push will not propagate to Notion.";
	}
	return `Changing from ${directionName(previousDirection)} to ${directionName(nextDirection)} changes which side can write during the next sync.`;
}

export function databaseDirectionCounts(databases: Pick<SyncedDatabase, "direction">[]): DatabaseDirectionCounts {
	return databases.reduce<DatabaseDirectionCounts>((counts, entry) => {
		if (entry.direction === "bidirectional") counts.pegged++;
		else if (entry.direction === "push") counts.pushOnly++;
		else counts.pullOnly++;
		return counts;
	}, { pegged: 0, pullOnly: 0, pushOnly: 0 });
}

export function syncedDatabasesHeader(databases: Pick<SyncedDatabase, "direction">[]): string {
	const counts = databaseDirectionCounts(databases);
	return `Synced databases · ${counts.pegged} pegged · ${counts.pullOnly} pull-only · ${counts.pushOnly} push-only`;
}

export function pendingConflictCount(entry: Pick<SyncedDatabase, "direction">, conflicts: Conflict[]): number {
	return entry.direction === "bidirectional" ? conflicts.length : 0;
}

export function pendingConflictCountForEntry(entryId: string, conflicts: Conflict[]): number {
	return conflicts.filter((conflict) => !conflict.entryId || conflict.entryId === entryId).length;
}

export function syncHistoryTooltip(entry: Pick<SyncedDatabase, "lastSyncedAt" | "lastPulledAt" | "lastPushedAt" | "lastSyncStatus" | "lastSyncError">): SyncHistoryTooltip {
	const tooltip: SyncHistoryTooltip = {
		lastSyncedAt: entry.lastSyncedAt ?? null,
		lastPulledAt: entry.lastPulledAt ?? null,
		lastPushedAt: entry.lastPushedAt ?? null,
		lastStatus: entry.lastSyncStatus ?? "never",
	};
	if (entry.lastSyncError) {
		tooltip.lastError = entry.lastSyncError;
	}
	return tooltip;
}

export function syncHistoryTitle(entry: Pick<SyncedDatabase, "lastSyncedAt" | "lastPulledAt" | "lastPushedAt" | "lastSyncStatus" | "lastSyncError">): string {
	const tooltip = syncHistoryTooltip(entry);
	const lines = [
		`Last full sync: ${tooltip.lastSyncedAt ?? "Never"}`,
		`Last successful pull: ${tooltip.lastPulledAt ?? "Never"}`,
		`Last successful push: ${tooltip.lastPushedAt ?? "Never"}`,
		`Last status: ${tooltip.lastStatus}`,
	];
	if (tooltip.lastError) {
		lines.push(`Last error: ${tooltip.lastError}`);
	}
	return lines.join("\n");
}

export function lastEditSideIndicator(entry: Pick<SyncedDatabase, "direction">, conflicts: Conflict[]): string {
	if (pendingConflictCount(entry, conflicts) > 0) return "!";
	return "=";
}

export function autoSyncReadiness(entry: Pick<SyncedDatabase, "direction" | "outputFolder" | "current_phase" | "lastSyncStatus" | "current_sync_id">, conflicts: Conflict[]): string {
	if (entry.direction !== "bidirectional") return "Manual";
	if (pendingConflictCount(entry, conflicts) > 0) return "Blocked: conflicts";
	if (entry.current_sync_id) return "Paused: active sync";
	if (entry.current_phase !== "phase_2") return "Paused: first sync incomplete";
	if (!entry.outputFolder.trim()) return "Paused: missing folder";
	if (entry.lastSyncStatus && ["partial", "error", "cancelled", "interrupted"].includes(entry.lastSyncStatus)) {
		return `Blocked: ${entry.lastSyncStatus}`;
	}
	return "Background push paused";
}

export function autoSyncEffectiveLabel(
	settings: Pick<NotionFreezeSettings, "autoSyncEnabled" | "autoSyncDatabasesByDefault" | "autoSyncPagesByDefault">,
	entry: Pick<SyncedDatabase, "autoSync"> | Pick<PageSyncEntry, "autoSync" | "type">,
	entryType: "database" | "page"
): string {
	if (!settings.autoSyncEnabled) return "Auto-sync off globally";
	if (entry.autoSync === "off") return "Auto-sync off";
	if (entry.autoSync === "on") return "Auto-sync on";
	return effectiveAutoSyncEnabled(settings, entry, entryType)
		? "Auto-sync inherited on"
		: "Auto-sync inherited off";
}

export function groupedSyncEntries(
	groups: SyncGroup[],
	databases: SyncedDatabase[],
	pages: PageSyncEntry[]
): GroupedSyncEntries[] {
	const knownGroupIds = new Set(groups.map((group) => group.id));
	const result: GroupedSyncEntries[] = [{
		group: null,
		databases: databases.filter((entry) => !entry.groupId || !knownGroupIds.has(entry.groupId)),
		pages: pages.filter((entry) => !entry.groupId || !knownGroupIds.has(entry.groupId)),
	}];
	for (const group of groups) {
		result.push({
			group,
			databases: databases.filter((entry) => entry.groupId === group.id),
			pages: pages.filter((entry) => entry.groupId === group.id),
		});
	}
	return result;
}

export function folderScopeWarning(
	settings: NotionFreezeSettings,
	entry: SyncedDatabase
): FolderScopeWarning | null {
	const folder = normalizeFolder(resolveDatabaseContentFolder(settings, entry));
	if (!folder) return null;
	const sharedCount = settings.databases.filter((candidate) =>
		candidate.id !== entry.id && normalizeFolder(resolveDatabaseContentFolder(settings, candidate)) === folder
	).length;
	if (sharedCount === 0) return null;
	return {
		sharedCount,
		message: `Folder shared with ${sharedCount} other database${sharedCount === 1 ? "" : "s"}; Push scans that folder.`,
	};
}

export function syncErrorSummary(errors: Pick<SyncError, "error">[]): SyncErrorSummary {
	const warnings = errors.filter((error) => isProtectiveWarning(error.error)).length;
	const failures = errors.length - warnings;
	if (warnings > 0 && failures === 0) {
		return { failures, warnings, label: `${warnings} skipped row${warnings === 1 ? "" : "s"}` };
	}
	if (warnings > 0) {
		return { failures, warnings, label: `${failures} failed, ${warnings} skipped` };
	}
	return { failures, warnings, label: `${failures} row failure${failures === 1 ? "" : "s"}` };
}

/**
 * Fetches display metadata for a Notion database without throwing UI-facing errors.
 */
export async function fetchDatabaseMetadata(
	databaseId: string,
	client: MetadataClient
): Promise<FetchDatabaseMetadataResult> {
	try {
		const database = await client.databases.retrieve({ database_id: databaseId });
		const title = extractTitle(database);
		const dataSourceId = (database as { data_sources?: Array<{ id: string }> }).data_sources?.[0]?.id ?? databaseId;
		const dataSource = await client.dataSources.retrieve({ data_source_id: dataSourceId });
		const properties = (dataSource as { properties?: Record<string, unknown> }).properties ?? {};
		const metadata: DatabaseMetadata = {
			title,
			propertyCount: Object.keys(properties).length,
		};

		try {
			const rows = await client.dataSources.query({
				data_source_id: dataSourceId,
				page_size: 100,
			});
			metadata.rowCount = rows.has_more ? "100+" : String(rows.results.length);
			metadata.rowCountApproximate = rows.has_more;
		} catch {
			// Row counts are best-effort; title and property metadata are still useful.
		}

		return { ok: true, metadata };
	} catch (err) {
		return { ok: false, error: truncateError(err) };
	}
}

function directionPreviewLine(direction: SyncDirection, rowCount: string | undefined, markdownFiles: number): string {
	const rows = rowCount ?? "unknown";
	if (direction === "push") {
		return `With Push selected: this sync will create ${markdownFiles} Notion rows${markdownFiles === 0 ? " (empty vault folder)" : ""}.`;
	}
	if (direction === "bidirectional") {
		return `With Bidirectional selected: ${rows} files created, ${markdownFiles} rows pushed${markdownFiles === 0 ? " (vault empty)" : ""}.`;
	}
	return `With Pull selected: this sync will create ${rows} markdown files.`;
}

function displayFolderPath(path: string): string {
	return path.endsWith("/") ? path : `${path}/`;
}

function normalizeFolder(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
}

function isProtectiveWarning(message: string): boolean {
	return message.startsWith("Warning:");
}

function directionName(direction: SyncDirection): string {
	if (direction === "push") return "Push";
	if (direction === "bidirectional") return "Bidirectional";
	return "Pull";
}

function extractTitle(database: unknown): string {
	const title = (database as { title?: Array<{ plain_text?: string }> }).title ?? [];
	const text = title.map((part) => part.plain_text ?? "").join("").trim();
	return text || "Untitled database";
}

function truncateError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return message.length > 200 ? `${message.slice(0, 197)}...` : message;
}
