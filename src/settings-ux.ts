import { Client } from "@notionhq/client";

export interface DatabaseMetadata {
	title: string;
	propertyCount?: number;
	rowCount?: string;
	rowCountApproximate?: boolean;
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

function extractTitle(database: unknown): string {
	const title = (database as { title?: Array<{ plain_text?: string }> }).title ?? [];
	const text = title.map((part) => part.plain_text ?? "").join("").trim();
	return text || "Untitled database";
}

function truncateError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return message.length > 200 ? `${message.slice(0, 197)}...` : message;
}
