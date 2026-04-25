import { Client } from "@notionhq/client";
import {
	DatabaseObjectResponse,
	PageObjectResponse,
} from "@notionhq/client/build/src/api-endpoints";
import { App, normalizePath, TFile, TFolder } from "obsidian";
import { DatabaseSyncResult } from "./types";
import { convertRichText } from "./block-converter";
import { notionRequest } from "./notion-client";

const CHUNK_LIMIT = 1900;
const INTERNAL_FRONTMATTER_KEYS = new Set([
	"notion-id",
	"notion-url",
	"notion-frozen-at",
	"notion-last-edited",
	"notion-last-edited-time",
	"notion-database-id",
	"notion-deleted",
]);

type PropertySchema = Record<string, { type: string }>;

export interface PushContext {
	titleToPageId: Map<string, string>;
	titleToNotionId: Map<string, string>;
	notionIdToPageId: Map<string, string>;
	warnings: string[];
}

interface MarkdownDocument {
	file: TFile;
	props: Record<string, unknown>;
	body: string;
	title: string;
}

interface ExistingPage {
	id: string;
	title: string;
}

interface NotionDateValue {
	start?: unknown;
	end?: unknown;
	time_zone?: unknown;
}

export async function pushDatabase(
	app: App,
	client: Client,
	databaseId: string,
	sourceFolder: string
): Promise<DatabaseSyncResult> {
	const database = (await notionRequest(() =>
		client.databases.retrieve({ database_id: databaseId })
	)) as DatabaseObjectResponse;

	const dbTitle = convertRichText(database.title) || "Untitled Database";
	const dataSourceId = database.data_sources?.[0]?.id ?? databaseId;
	const schema = await getWritableSchema(client, database, dataSourceId);
	const titlePropName = findTitleProperty(schema);
	if (!titlePropName) {
		throw new Error(`No title property found for "${dbTitle}".`);
	}

	const docs = await readMarkdownDocuments(app, sourceFolder, titlePropName);
	const existingPages = await queryAllPages(client, dataSourceId, titlePropName);
	const byTitle = new Map(existingPages.map((page) => [page.title, page.id]));
	const byId = new Map(existingPages.flatMap((page) => notionIdKeys(page.id).map((key) => [key, page.id])));
	const ctx: PushContext = {
		titleToPageId: byTitle,
		titleToNotionId: new Map(),
		notionIdToPageId: byId,
		warnings: [],
	};

	let created = 0;
	let updated = 0;
	let failed = 0;
	let skipped = 0;
	const errors: string[] = [];

	for (const doc of docs) {
		const notionId = typeof doc.props["notion-id"] === "string" ? doc.props["notion-id"] : null;
		if (notionId && !byId.has(notionId) && !byId.has(compactNotionId(notionId))) {
			skipped++;
			ctx.warnings.push(
				`${doc.file.path}: notion-id ${notionId} was not found in target database; skipped to avoid creating a duplicate.`
			);
			continue;
		}

		const existingId = notionId
			? byId.get(notionId) ?? byId.get(compactNotionId(notionId))
			: byTitle.get(doc.title);
		const properties = buildPageProperties(doc, schema, titlePropName, ctx);

		try {
			if (existingId) {
				const page = await notionRequest(() =>
					client.pages.update({
						page_id: existingId,
						properties,
					} as never)
				);
				await refreshFrontmatterNotionId(app, doc, getReturnedPageId(page) ?? existingId);
				updated++;
			} else {
				const page = await notionRequest(() =>
					client.pages.create({
						parent: { database_id: databaseId },
						properties,
					} as never)
				);
				const returnedId = getReturnedPageId(page);
				if (returnedId) {
					await refreshFrontmatterNotionId(app, doc, returnedId);
				}
				created++;
			}
		} catch (err) {
			failed++;
			const msg = `${doc.file.path}: ${err instanceof Error ? err.message : String(err)}`;
			errors.push(msg);
			console.error("Stonerelay push error:", err);
		}
	}

	for (const warning of ctx.warnings) {
		errors.push(`Warning: ${warning}`);
	}

	return {
		title: dbTitle,
		folderPath: normalizePath(sourceFolder),
		total: docs.length,
		created,
		updated,
		skipped,
		deleted: 0,
		failed,
		errors,
	};
}

export function buildPageProperties(
	doc: Pick<MarkdownDocument, "props" | "title">,
	schema: PropertySchema,
	titlePropName: string,
	ctx: PushContext
): Record<string, unknown> {
	const properties: Record<string, unknown> = {
		[titlePropName]: { title: chunkText(doc.title) },
	};

	for (const [name, value] of Object.entries(doc.props)) {
		if (INTERNAL_FRONTMATTER_KEYS.has(name) || name === titlePropName) continue;
		const property = schema[name];
		if (!property) continue;
		const payload = frontmatterValueToNotionPayload(property.type, name, value, ctx);
		if (payload !== undefined) {
			properties[name] = payload;
		}
	}

	return properties;
}

export function frontmatterValueToNotionPayload(
	propType: string,
	propName: string,
	value: unknown,
	ctx: PushContext = emptyPushContext()
): Record<string, unknown> | undefined {
	if (propType === "date") return dateValueToNotionPayload(value);
	if (value === "" || value === undefined || value === null) return undefined;
	if (Array.isArray(value) && value.length === 0) return undefined;

	switch (propType) {
		case "title":
			return { title: chunkText(String(value)) };
		case "rich_text":
			return { rich_text: chunkText(String(value)) };
		case "number": {
			const number = Number(value);
			return Number.isNaN(number) ? undefined : { number };
		}
		case "select": {
			const name = String(value).trim();
			return name ? { select: { name } } : undefined;
		}
		case "multi_select": {
			const values = (Array.isArray(value) ? value : String(value).split(","))
				.map((item) => String(item).trim())
				.filter(Boolean);
			return values.length > 0
				? { multi_select: values.map((name) => ({ name })) }
				: undefined;
		}
		case "status": {
			const name = String(value).trim();
			return name ? { status: { name } } : undefined;
		}
		case "date": {
			return dateValueToNotionPayload(value);
		}
		case "checkbox": {
			const checkbox = typeof value === "boolean"
				? value
				: /^(true|yes|1)$/i.test(String(value));
			return { checkbox };
		}
		case "url":
			return { url: String(value) };
		case "email":
			return { email: String(value) };
		case "phone_number":
			return { phone_number: String(value) };
		case "relation": {
			const relation = relationIds(value, ctx, propName);
			return relation.length > 0 ? { relation } : undefined;
		}
		case "people":
		case "files":
		case "formula":
		case "rollup":
		case "unique_id":
		case "created_time":
		case "created_by":
		case "last_edited_time":
		case "last_edited_by":
		case "button":
		case "verification":
			return undefined;
		default:
			ctx.warnings.push(`Unhandled property type "${propType}" for "${propName}"`);
			return undefined;
	}
}

export function chunkText(value: string): Array<{ type: "text"; text: { content: string } }> {
	if (!value) return [];
	const chunks: string[] = [];
	let buffer = value;

	while (buffer.length > CHUNK_LIMIT) {
		let cut = buffer.lastIndexOf("\n\n", CHUNK_LIMIT);
		if (cut < CHUNK_LIMIT * 0.5) {
			const sentenceCut = buffer.lastIndexOf(". ", CHUNK_LIMIT);
			cut = sentenceCut >= CHUNK_LIMIT * 0.5 ? sentenceCut + 1 : sentenceCut;
		}
		if (cut < CHUNK_LIMIT * 0.5) cut = buffer.lastIndexOf(" ", CHUNK_LIMIT);
		if (cut <= 0) cut = CHUNK_LIMIT;
		chunks.push(buffer.slice(0, cut));
		buffer = buffer.slice(cut).replace(/^\s+/, "");
	}
	if (buffer.length) chunks.push(buffer);

	return chunks.map((content) => ({ type: "text", text: { content } }));
}

export function parseFrontmatter(raw: string): { props: Record<string, unknown>; body: string } {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return { props: {}, body: raw };

	const props: Record<string, unknown> = {};
	const lines = match[1].split(/\r?\n/);
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (!line.trim()) {
			i++;
			continue;
		}
		const keyMatch = line.match(/^("([^"]*)"|([^:]+)):\s*(.*)$/);
		if (!keyMatch) {
			i++;
			continue;
		}
		const key = (keyMatch[2] !== undefined ? keyMatch[2] : keyMatch[3]).trim();
		const rawValue = keyMatch[4];
		if (rawValue === "" || rawValue === undefined) {
			const items: unknown[] = [];
			let j = i + 1;
			while (j < lines.length && /^\s+-\s/.test(lines[j])) {
				items.push(parseScalar(lines[j].replace(/^\s+-\s/, "")));
				j++;
			}
			props[key] = items.length > 0 ? items : "";
			i = items.length > 0 ? j : i + 1;
			continue;
		}
		props[key] = parseScalar(rawValue.trim());
		i++;
	}

	return { props, body: match[2] };
}

async function getWritableSchema(
	client: Client,
	database: DatabaseObjectResponse,
	dataSourceId: string
): Promise<PropertySchema> {
	if ("dataSources" in client && client.dataSources) {
		const source = await notionRequest(() =>
			client.dataSources.retrieve({ data_source_id: dataSourceId })
		) as { properties?: PropertySchema };
		if (source.properties) return source.properties;
	}
	return (database as { properties?: PropertySchema }).properties ?? {};
}

function findTitleProperty(schema: PropertySchema): string | null {
	for (const [name, property] of Object.entries(schema)) {
		if (property.type === "title") return name;
	}
	return null;
}

async function queryAllPages(
	client: Client,
	dataSourceId: string,
	titlePropName: string
): Promise<ExistingPage[]> {
	const pages: ExistingPage[] = [];
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
			if (result.object !== "page" || !("properties" in result)) continue;
			const page = result as PageObjectResponse;
			const prop = page.properties[titlePropName];
			const title = prop?.type === "title" ? convertRichText(prop.title).trim() : "";
			pages.push({ id: page.id, title });
		}
		cursor = response.has_more
			? (response.next_cursor ?? undefined)
			: undefined;
	} while (cursor);

	return pages;
}

async function readMarkdownDocuments(
	app: App,
	sourceFolder: string,
	titlePropName: string
): Promise<MarkdownDocument[]> {
	const normalizedFolder = normalizePath(sourceFolder).replace(/\/+$/, "");
	const folder = app.vault.getAbstractFileByPath(normalizedFolder);
	if (!(folder instanceof TFolder)) {
		throw new Error(`Source folder not found: ${sourceFolder}`);
	}

	const docs: MarkdownDocument[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		if (!isPushableFile(file, normalizedFolder)) continue;
		const raw = await app.vault.cachedRead(file);
		const { props, body } = parseFrontmatter(raw);
		docs.push({
			file,
			props,
			body,
			title: getDocumentTitle(file, props, body, titlePropName),
		});
	}
	return docs;
}

function isPushableFile(file: TFile, sourceFolder: string): boolean {
	if (file.extension !== "md") return false;
	if (file.name.startsWith(".")) return false;
	if (file.path.split("/").some((part) => part.startsWith(".") || part === ".trash")) return false;
	return file.path === sourceFolder || file.path.startsWith(`${sourceFolder}/`);
}

function getDocumentTitle(
	file: TFile,
	props: Record<string, unknown>,
	body: string,
	titlePropName: string
): string {
	const frontmatterTitle = props[titlePropName] ?? props.title ?? props.Title;
	if (frontmatterTitle) return String(frontmatterTitle).trim();
	const heading = body.match(/^#\s+(.+)$/m)?.[1];
	if (heading) return heading.trim();
	return file.basename;
}

function relationIds(
	value: unknown,
	ctx: PushContext,
	propName: string
): Array<{ id: string }> {
	const values = Array.isArray(value) ? value : String(value).split(",");
	const ids: Array<{ id: string }> = [];

	for (const item of values) {
		const text = String(item).trim();
		if (!text) continue;
		const wikilink = text.match(/^\[\[(.+?)(\|.+?)?\]\]$/)?.[1]?.trim();
		const id = looksLikeNotionId(text)
			? text
			: wikilink
				? ctx.titleToPageId.get(wikilink) || ctx.notionIdToPageId.get(ctx.titleToNotionId.get(wikilink) ?? "")
				: ctx.titleToPageId.get(text);
		if (id) {
			ids.push({ id });
		} else {
			ctx.warnings.push(`Unresolved relation on "${propName}": ${text}`);
		}
	}

	return ids;
}

function looksLikeNotionId(value: string): boolean {
	return /^[a-f0-9-]{32,36}$/i.test(value);
}

function compactNotionId(value: string): string {
	return value.replace(/-/g, "").toLowerCase();
}

function notionIdKeys(value: string): string[] {
	const compact = compactNotionId(value);
	return compact === value ? [value] : [value, compact];
}

function getReturnedPageId(value: unknown): string | null {
	if (value && typeof value === "object" && "id" in value) {
		const id = (value as { id?: unknown }).id;
		return typeof id === "string" && id ? id : null;
	}
	return null;
}

async function refreshFrontmatterNotionId(
	app: App,
	doc: MarkdownDocument,
	notionId: string
): Promise<void> {
	if (!notionId || doc.props["notion-id"] === notionId) return;
	const raw = await app.vault.cachedRead(doc.file);
	const next = upsertFrontmatterValue(raw, "notion-id", notionId);
	if (next !== raw) await app.vault.modify(doc.file, next);
	doc.props["notion-id"] = notionId;
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

function dateValueToNotionPayload(value: unknown): Record<string, unknown> {
	if (value === "" || value === undefined || value === null) return { date: null };

	const structured = parseDateObject(value);
	if (structured) {
		const start = typeof structured.start === "string" ? structured.start.trim() : "";
		if (!start) return { date: null };
		const date: Record<string, string> = { start };
		if (typeof structured.end === "string" && structured.end.trim()) {
			date.end = structured.end.trim();
		}
		if (typeof structured.time_zone === "string" && structured.time_zone.trim()) {
			date.time_zone = structured.time_zone.trim();
		}
		return { date };
	}

	const text = String(value).trim();
	if (!text) return { date: null };
	const [start, end] = text.includes("→")
		? text.split("→").map((part) => part.trim())
		: [text, ""];
	return { date: end ? { start, end } : { start } };
}

function parseDateObject(value: unknown): NotionDateValue | null {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as NotionDateValue;
	}
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (!text.startsWith("{") || !text.endsWith("}")) return null;
	try {
		const parsed = JSON.parse(text) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed as NotionDateValue
			: null;
	} catch {
		return null;
	}
}

function yamlEscapeString(str: string): string {
	if (
		str.includes(":") ||
		str.includes("#") ||
		str.includes("'") ||
		str.includes('"') ||
		str.includes("\n") ||
		str.startsWith(" ") ||
		str.startsWith("-") ||
		str.startsWith("[") ||
		str.startsWith("{") ||
		str === "true" ||
		str === "false" ||
		str === "null" ||
		/^\d+$/.test(str)
	) {
		return `"${str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
	}
	return str;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseScalar(value: string): unknown {
	const unquoted = stripQuotes(value);
	if (unquoted === "null") return null;
	if (unquoted === "true") return true;
	if (unquoted === "false") return false;
	if (/^-?\d+(\.\d+)?$/.test(unquoted)) return Number(unquoted);
	return unquoted.replace(/\\n/g, "\n");
}

function stripQuotes(value: string): string {
	if (
		(value.startsWith("\"") && value.endsWith("\"")) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
	}
	return value;
}

function emptyPushContext(): PushContext {
	return {
		titleToPageId: new Map(),
		titleToNotionId: new Map(),
		notionIdToPageId: new Map(),
		warnings: [],
	};
}
