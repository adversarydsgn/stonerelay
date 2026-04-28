import {
	PageObjectResponse,
} from "@notionhq/client/build/src/api-endpoints";
import { App, normalizePath, TFile } from "obsidian";
import { PageWriteOptions, PageWriteResult, StandalonePageWriteOptions } from "./types";
import { convertBlocksToMarkdown, convertRichText, fetchAllChildren } from "./block-converter";
import { modifyAtomic, writeAtomic } from "./atomic-vault-write";
import type { ReservationContext } from "./reservations";

const MAX_FILENAME_STEM_BYTES = 180;

export async function writeDatabaseEntry(
	app: App,
	options: PageWriteOptions
): Promise<PageWriteResult> {
	const { client, page, outputFolder, databaseId } = options;
	requireReservation(options.context, "database entry write");

	const title = getPageTitle(page);
	const safeName = safeFileNameForPage(title || "Untitled", page.id);
	const filePath = normalizePath(`${outputFolder}/${safeName}.md`);

	// Fetch all blocks
	const blocks = await fetchAllChildren(client, page.id);
	const markdown = await convertBlocksToMarkdown(blocks, {
		client,
		indentLevel: 0,
	});

	// Build frontmatter
	const frontmatter: Record<string, unknown> = {
		"notion-id": page.id,
		"notion-url": page.url,
		"notion-frozen-at": new Date().toISOString(),
		"notion-last-edited": page.last_edited_time,
		"notion-database-id": databaseId,
	};

	// Map database entry properties to frontmatter
	mapPropertiesToFrontmatter(page.properties, frontmatter);

	const content = buildFileContent(frontmatter, markdown);

	// Write file
	const existingFile = app.vault.getAbstractFileByPath(filePath);
	if (existingFile instanceof TFile) {
		await modifyAtomic(app.vault, existingFile, content, { onCommitted: options.onAtomicWriteCommitted });
		return { status: "updated", filePath, title: safeName };
	} else {
		await ensureFolder(app, outputFolder);
		await writeAtomic(app.vault, filePath, content, { onCommitted: options.onAtomicWriteCommitted });
		return { status: "created", filePath, title: safeName };
	}
}

export async function writeStandalonePage(
	app: App,
	options: StandalonePageWriteOptions
): Promise<PageWriteResult> {
	const { client, page, outputFolder } = options;
	requireReservation(options.context, "standalone page write");
	const title = getStandalonePageTitle(page);
	const safeName = safeFileNameForPage(title || "Untitled", page.id);
	const filePath = normalizePath(`${outputFolder}/${safeName}.md`);
	const blocks = await fetchAllChildren(client, page.id);
	const markdown = await convertBlocksToMarkdown(blocks, {
		client,
		indentLevel: 0,
	});
	const parent = (page as { parent?: { type?: string } }).parent;
	const frontmatter: Record<string, unknown> = {
		"notion-id": page.id,
		"notion-url": page.url,
		"notion-frozen-at": new Date().toISOString(),
		"notion-last-edited": page.last_edited_time,
	};
	if (parent?.type) {
		frontmatter["notion-parent-type"] = parent.type;
	}
	const content = buildFileContent(frontmatter, markdown);
	const existingFile = app.vault.getAbstractFileByPath(filePath);
	if (existingFile instanceof TFile) {
		await modifyAtomic(app.vault, existingFile, content, { onCommitted: options.onAtomicWriteCommitted });
		return { status: "updated", filePath, title: safeName };
	}
	await ensureFolder(app, outputFolder);
	await writeAtomic(app.vault, filePath, content, { onCommitted: options.onAtomicWriteCommitted });
	return { status: "created", filePath, title: safeName };
}

function requireReservation(context: ReservationContext | undefined, writer: string): void {
	if (!context?.id) {
		throw new Error(`Reservation required before ${writer}.`);
	}
}

function getPageTitle(page: PageObjectResponse): string {
	for (const prop of Object.values(page.properties)) {
		if (prop.type === "title") {
			return convertRichText(prop.title);
		}
	}
	return "Untitled";
}

function getStandalonePageTitle(page: PageObjectResponse): string {
	const title = getPageTitle(page);
	if (title !== "Untitled") return title;
	const props = (page as { properties?: Record<string, unknown> }).properties ?? {};
	for (const value of Object.values(props)) {
		const prop = value as { type?: string; title?: Parameters<typeof convertRichText>[0] };
		if (prop.type === "title" && prop.title) {
			const text = convertRichText(prop.title);
			if (text.trim()) return text;
		}
	}
	return "Untitled";
}

function simplifyRollupItem(item: Record<string, unknown>): unknown {
	const t = item.type as string | undefined;
	if (!t) return JSON.stringify(item);
	const inner = (item as Record<string, unknown>)[t];
	if (inner === null || inner === undefined) return null;
	switch (t) {
		case "title":
		case "rich_text":
			return Array.isArray(inner) ? convertRichText(inner as Parameters<typeof convertRichText>[0]) : String(inner);
		case "number":
			return inner as number;
		case "select":
			return (inner as { name?: string } | null)?.name ?? null;
		case "multi_select":
			return Array.isArray(inner) ? (inner as Array<{ name: string }>).map((s) => s.name) : [];
		case "status":
			return (inner as { name?: string } | null)?.name ?? null;
		case "date": {
			const d = inner as { start: string; end: string | null } | null;
			if (!d) return null;
			return d.end ? `${d.start} → ${d.end}` : d.start;
		}
		case "checkbox":
			return inner as boolean;
		case "url":
		case "email":
		case "phone_number":
			return inner as string | null;
		case "people":
			return Array.isArray(inner) ? (inner as Array<{ id: string; name?: string | null }>).map((p) => p.name || p.id) : [];
		case "relation":
			return Array.isArray(inner) ? (inner as Array<{ id: string }>).map((r) => r.id) : [];
		default:
			return JSON.stringify(inner);
	}
}

export function safeFileNameForPage(name: string, pageId: string): string {
	const sanitized = sanitizeFileName(name);
	if (utf8ByteLength(sanitized) <= MAX_FILENAME_STEM_BYTES) return sanitized;

	const suffix = `--${pageId.replace(/-/g, "").slice(0, 8) || "notion"}`;
	const prefix = truncateUtf8(sanitized, MAX_FILENAME_STEM_BYTES - utf8ByteLength(suffix))
		.replace(/[\s.-]+$/g, "");
	return `${prefix || "Untitled"}${suffix}`;
}

function sanitizeFileName(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, "-").trim() || "Untitled";
}

function truncateUtf8(value: string, maxBytes: number): string {
	let result = "";
	let bytes = 0;
	for (const char of value) {
		const nextBytes = utf8ByteLength(char);
		if (bytes + nextBytes > maxBytes) break;
		result += char;
		bytes += nextBytes;
	}
	return result;
}

function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}

function mapPropertiesToFrontmatter(
	properties: PageObjectResponse["properties"],
	frontmatter: Record<string, unknown>
): void {
	for (const [key, prop] of Object.entries(properties)) {
		switch (prop.type) {
			case "title":
				// Already used as filename, skip
				break;
			case "rich_text":
				frontmatter[key] = convertRichText(
					prop.rich_text
				);
				break;
			case "number":
				frontmatter[key] = prop.number;
				break;
			case "select":
				frontmatter[key] = prop.select?.name ?? null;
				break;
			case "multi_select":
				frontmatter[key] = prop.multi_select.map(
					(s: { name: string }) => s.name
				);
				break;
			case "status":
				frontmatter[key] = prop.status?.name ?? null;
				break;
			case "date":
				if (prop.date) {
					frontmatter[key] = prop.date.time_zone
						? {
							start: prop.date.start,
							end: prop.date.end,
							time_zone: prop.date.time_zone,
						}
						: prop.date.end
							? `${prop.date.start} → ${prop.date.end}`
							: prop.date.start;
				} else {
					frontmatter[key] = null;
				}
				break;
			case "checkbox":
				frontmatter[key] = prop.checkbox;
				break;
			case "url":
				frontmatter[key] = prop.url;
				break;
			case "email":
				frontmatter[key] = prop.email;
				break;
			case "phone_number":
				frontmatter[key] = prop.phone_number;
				break;
			case "relation":
				frontmatter[key] = prop.relation.map(
					(r: { id: string }) => r.id
				);
				break;
			case "people":
				frontmatter[key] = prop.people.map(
					(p: { id: string; name?: string | null }) => p.name || p.id
				);
				break;
			case "files":
				frontmatter[key] = prop.files.map(
					(f: { name: string; type: string; file?: { url: string }; external?: { url: string } }) =>
						f.type === "file" ? f.file?.url : f.external?.url
				);
				break;
			case "created_time":
				frontmatter[key] = prop.created_time;
				break;
			case "last_edited_time":
				frontmatter[key] = prop.last_edited_time;
				break;
			case "unique_id": {
				const uid = (prop as { unique_id: { prefix: string | null; number: number | null } }).unique_id;
				if (uid && uid.number !== null && uid.number !== undefined) {
					frontmatter[key] = uid.prefix ? `${uid.prefix}-${uid.number}` : String(uid.number);
				} else {
					frontmatter[key] = null;
				}
				break;
			}
			case "formula": {
				const f = (prop as { formula: { type: string; string?: string | null; number?: number | null; boolean?: boolean | null; date?: { start: string; end: string | null } | null } }).formula;
				if (!f) {
					frontmatter[key] = null;
				} else if (f.type === "string") {
					frontmatter[key] = f.string ?? null;
				} else if (f.type === "number") {
					frontmatter[key] = f.number ?? null;
				} else if (f.type === "boolean") {
					frontmatter[key] = f.boolean ?? null;
				} else if (f.type === "date") {
					if (f.date) {
						frontmatter[key] = f.date.end ? `${f.date.start} → ${f.date.end}` : f.date.start;
					} else {
						frontmatter[key] = null;
					}
				} else {
					frontmatter[key] = null;
				}
				break;
			}
			case "rollup": {
				const r = (prop as { rollup: { type: string; number?: number | null; date?: { start: string; end: string | null } | null; array?: Array<Record<string, unknown>> } }).rollup;
				if (!r) {
					frontmatter[key] = null;
				} else if (r.type === "number") {
					frontmatter[key] = r.number ?? null;
				} else if (r.type === "date") {
					if (r.date) {
						frontmatter[key] = r.date.end ? `${r.date.start} → ${r.date.end}` : r.date.start;
					} else {
						frontmatter[key] = null;
					}
				} else if (r.type === "array" && Array.isArray(r.array)) {
					frontmatter[key] = r.array.map((item) => simplifyRollupItem(item));
				} else {
					frontmatter[key] = null;
				}
				break;
			}
			case "verification": {
				const v = (prop as { verification: { state: string } | null }).verification;
				frontmatter[key] = v?.state ?? null;
				break;
			}
			case "created_by": {
				const u = (prop as { created_by: { id: string; name?: string | null } }).created_by;
				frontmatter[key] = u ? (u.name || u.id) : null;
				break;
			}
			case "last_edited_by": {
				const u = (prop as { last_edited_by: { id: string; name?: string | null } }).last_edited_by;
				frontmatter[key] = u ? (u.name || u.id) : null;
				break;
			}
			// Skip button — non-user-content type
			default:
				break;
		}
	}
}

export function buildFileContent(
	frontmatter: Record<string, unknown>,
	body: string
): string {
	const yamlLines: string[] = ["---"];
	for (const [key, value] of Object.entries(frontmatter)) {
		yamlLines.push(formatYamlEntry(key, value));
	}
	yamlLines.push("---");
	return yamlLines.join("\n") + "\n" + body;
}

function formatYamlEntry(key: string, value: unknown): string {
	const safeKey = key.includes(":") || key.includes(" ") ? `"${key}"` : key;

	if (value === null || value === undefined) {
		return `${safeKey}: null`;
	}
	if (typeof value === "boolean") {
		return `${safeKey}: ${value}`;
	}
	if (typeof value === "number") {
		return `${safeKey}: ${value}`;
	}
	if (Array.isArray(value)) {
		if (value.length === 0) return `${safeKey}: []`;
		const items = value.map((v) => `  - ${yamlEscapeString(String(v))}`);
		return `${safeKey}:\n${items.join("\n")}`;
	}
	if (typeof value === "object") {
		return `${safeKey}: ${yamlEscapeString(JSON.stringify(value))}`;
	}
	return `${safeKey}: ${yamlEscapeString(String(value))}`;
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

async function ensureFolder(app: App, path: string): Promise<void> {
	const normalized = normalizePath(path);
	if (app.vault.getAbstractFileByPath(normalized)) return;

	// Create parent folders recursively
	const parts = normalized.split("/");
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!app.vault.getAbstractFileByPath(current)) {
			await app.vault.createFolder(current);
		}
	}
}
