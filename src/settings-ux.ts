import { Client } from "@notionhq/client";
import { SyncDirection } from "./types";

export interface DatabaseMetadata {
	title: string;
	propertyCount?: number;
	rowCount?: string;
	rowCountApproximate?: boolean;
}

export const DIRECTION_LABELS: Record<SyncDirection, string> = {
	pull: "Pull (Notion is source — vault gets seeded)",
	push: "Push (Vault is source — Notion gets seeded)",
	bidirectional: "Bidirectional (both authoritative — v0.7+ only)",
};

export const DIRECTION_OPTION_ORDER: SyncDirection[] = ["pull", "push", "bidirectional"];

export const DIRECTION_SECTION_HELPER =
	"Pull seeds vault from Notion. Push seeds Notion from vault. Bidirectional uses last-writer-wins until v0.7 ships proper conflict resolution.";

export const DIRECTION_HELPER =
	"Bidirectional uses last-writer-wins until v0.7 ships proper conflict resolution. Use only if you understand the risk.";

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

function extractTitle(database: unknown): string {
	const title = (database as { title?: Array<{ plain_text?: string }> }).title ?? [];
	const text = title.map((part) => part.plain_text ?? "").join("").trim();
	return text || "Untitled database";
}

function truncateError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return message.length > 200 ? `${message.slice(0, 197)}...` : message;
}
