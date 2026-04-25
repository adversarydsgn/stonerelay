import { Client } from "@notionhq/client";
import {
	BlockObjectResponse,
	RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints";
import { notionRequest } from "./notion-client";

interface ConvertContext {
	client: Client;
	indentLevel: number;
}

export async function convertBlocksToMarkdown(
	blocks: BlockObjectResponse[],
	ctx: ConvertContext
): Promise<string> {
	const lines: string[] = [];
	let numberedIndex = 1;

	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];

		// Reset numbered list counter when block type changes
		if (block.type !== "numbered_list_item") {
			numberedIndex = 1;
		}

		const result = await convertBlock(block, ctx, numberedIndex);
		if (block.type === "numbered_list_item") {
			numberedIndex++;
		}

		lines.push(result);
	}

	return lines.join("\n");
}

async function convertBlock(
	block: BlockObjectResponse,
	ctx: ConvertContext,
	numberedIndex: number
): Promise<string> {
	const indent = "    ".repeat(ctx.indentLevel);
	const blockType = block.type as string;

	if (
		blockType === "heading_4" ||
		blockType === "heading_5" ||
		blockType === "heading_6"
	) {
		const level = Number(blockType.slice(-1)) as HeadingLevel;
		const heading = (
			block as unknown as Record<
				string,
				{ rich_text: RichTextItemResponse[]; is_toggleable?: boolean }
			>
		)[blockType];
		return convertHeading(heading, level, block, ctx);
	}

	switch (block.type) {
		case "paragraph": {
			const text = convertRichText(block.paragraph.rich_text);
			const children = await maybeConvertChildren(block, ctx);
			return text + children;
		}

		case "heading_1": {
			return convertHeading(block.heading_1, 1, block, ctx);
		}

		case "heading_2": {
			return convertHeading(block.heading_2, 2, block, ctx);
		}

		case "heading_3": {
			return convertHeading(block.heading_3, 3, block, ctx);
		}

		case "bulleted_list_item": {
			const text = convertRichText(block.bulleted_list_item.rich_text);
			const children = await maybeConvertChildren(block, {
				...ctx,
				indentLevel: ctx.indentLevel + 1,
			});
			return `${indent}- ${text}${children}`;
		}

		case "numbered_list_item": {
			const text = convertRichText(block.numbered_list_item.rich_text);
			const children = await maybeConvertChildren(block, {
				...ctx,
				indentLevel: ctx.indentLevel + 1,
			});
			return `${indent}${numberedIndex}. ${text}${children}`;
		}

		case "to_do": {
			const text = convertRichText(block.to_do.rich_text);
			const check = block.to_do.checked ? "x" : " ";
			const children = await maybeConvertChildren(block, {
				...ctx,
				indentLevel: ctx.indentLevel + 1,
			});
			return `${indent}- [${check}] ${text}${children}`;
		}

		case "code": {
			const text = convertRichText(block.code.rich_text);
			const lang = block.code.language === "plain text" ? "" : block.code.language;
			return `\`\`\`${lang}\n${text}\n\`\`\``;
		}

		case "quote": {
			const text = convertRichText(block.quote.rich_text);
			const childMd = await maybeConvertChildren(block, ctx);
			const combined = text + childMd;
			return combined
				.split("\n")
				.map((line) => `> ${line}`)
				.join("\n");
		}

		case "callout": {
			const text = convertRichText(block.callout.rich_text);
			const icon = block.callout.icon;
			const calloutType = emojiToCalloutType(icon);
			const childMd = await maybeConvertChildren(block, ctx);
			const body = text + childMd;
			const bodyLines = body
				.split("\n")
				.map((line) => `> ${line}`)
				.join("\n");
			return `> [!${calloutType}]\n${bodyLines}`;
		}

		case "equation": {
			return `$$\n${block.equation.expression}\n$$`;
		}

		case "divider": {
			return "---";
		}

		case "toggle": {
			const text = convertRichText(block.toggle.rich_text);
			const childMd = await maybeConvertChildren(block, ctx);
			const bodyLines = childMd
				.split("\n")
				.map((line) => `> ${line}`)
				.join("\n");
			return `> [!note]+ ${text}\n${bodyLines}`;
		}

		case "child_page": {
			return `[[${block.child_page.title}]]`;
		}

		case "child_database": {
			return `<!-- child database: ${block.child_database.title} -->`;
		}

		case "image": {
			const url =
				block.image.type === "external"
					? block.image.external.url
					: block.image.file.url;
			const caption = convertRichText(block.image.caption);
			return caption ? `![${caption}](${url})` : `![image](${url})`;
		}

		case "bookmark": {
			const caption = convertRichText(block.bookmark.caption);
			const url = block.bookmark.url;
			return caption ? `[${caption}](${url})` : url;
		}

		case "embed": {
			const caption = convertRichText(block.embed.caption);
			const url = block.embed.url;
			return caption ? `[${caption}](${url})` : url;
		}

		case "video": {
			const url =
				block.video.type === "external"
					? block.video.external.url
					: block.video.file.url;
			const caption = convertRichText(block.video.caption);
			return caption ? `[${caption}](${url})` : url;
		}

		case "file": {
			const url =
				block.file.type === "external"
					? block.file.external.url
					: block.file.file.url;
			const caption = convertRichText(block.file.caption);
			return caption ? `[${caption}](${url})` : url;
		}

		case "pdf": {
			const url =
				block.pdf.type === "external"
					? block.pdf.external.url
					: block.pdf.file.url;
			const caption = convertRichText(block.pdf.caption);
			return caption ? `[${caption}](${url})` : url;
		}

		case "audio": {
			const url =
				block.audio.type === "external"
					? block.audio.external.url
					: block.audio.file.url;
			const caption = convertRichText(block.audio.caption);
			return caption ? `[${caption}](${url})` : url;
		}

		case "table": {
			return await convertTable(block, ctx);
		}

		case "column_list": {
			return await convertColumnList(block, ctx);
		}

		case "column": {
			// Handled by column_list
			return "";
		}

		case "link_to_page": {
			const ltp = block.link_to_page;
			if (ltp.type === "page_id") {
				return `[[notion-id: ${ltp.page_id}]]`;
			}
			if (ltp.type === "database_id") {
				return `<!-- linked database: ${ltp.database_id} -->`;
			}
			return "";
		}

		case "synced_block": {
			// Fetch children of the synced block (or original)
			const children = await maybeConvertChildren(block, ctx);
			return children;
		}

		case "table_of_contents":
		case "breadcrumb":
			// These are UI-only elements in Notion, skip
			return "";

		default: {
			console.warn(`Unsupported Notion block type: ${block.type}`);
			return "";
		}
	}
}

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

async function convertHeading(
	heading: { rich_text: RichTextItemResponse[]; is_toggleable?: boolean },
	level: HeadingLevel,
	block: BlockObjectResponse,
	ctx: ConvertContext
): Promise<string> {
	const hashes = "#".repeat(level);
	const text = convertRichText(heading.rich_text);
	if (heading.is_toggleable) {
		const children = await maybeConvertChildren(block, ctx);
		return `> [!note]+ ${hashes} ${text}${children}`;
	}
	return `${hashes} ${text}`;
}

async function maybeConvertChildren(
	block: BlockObjectResponse,
	ctx: ConvertContext
): Promise<string> {
	if (!block.has_children) return "";

	const children = await fetchAllChildren(ctx.client, block.id);
	const childMd = await convertBlocksToMarkdown(children, ctx);
	if (!childMd) return "";
	return "\n" + childMd;
}

export async function fetchAllChildren(
	client: Client,
	blockId: string
): Promise<BlockObjectResponse[]> {
	const blocks: BlockObjectResponse[] = [];
	let cursor: string | undefined = undefined;

	do {
		const response = await notionRequest(() =>
			client.blocks.children.list({
				block_id: blockId,
				start_cursor: cursor,
				page_size: 100,
			})
		);
		for (const block of response.results) {
			if ("type" in block) {
				blocks.push(block);
			}
		}
		cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
	} while (cursor);

	return blocks;
}

export function convertRichText(richTexts: RichTextItemResponse[]): string {
	return richTexts.map(convertRichTextItem).join("");
}

function convertRichTextItem(item: RichTextItemResponse): string {
	let text: string;

	if (item.type === "equation") {
		text = `$${item.equation.expression}$`;
	} else if (item.type === "mention") {
		text = convertMention(item);
	} else {
		// text type
		if (item.text.link) {
			text = `[${item.text.content}](${item.text.link.url})`;
		} else {
			text = item.text.content;
		}
	}

	// Apply annotations
	const a = item.annotations;
	if (a.code) text = `\`${text}\``;
	if (a.bold) text = `**${text}**`;
	if (a.italic) text = `*${text}*`;
	if (a.strikethrough) text = `~~${text}~~`;
	if (a.underline) text = `<u>${text}</u>`;
	if (a.color !== "default" && a.color.endsWith("_background")) {
		text = `==${text}==`;
	}

	return text;
}

function convertMention(item: RichTextItemResponse): string {
	if (item.type !== "mention") return item.plain_text;

	const mention = item.mention;
	switch (mention.type) {
		case "page":
			return `[[notion-id: ${mention.page.id}]]`;
		case "database":
			return `[[notion-id: ${mention.database.id}]]`;
		case "date": {
			const d = mention.date;
			return d.end ? `${d.start} → ${d.end}` : d.start;
		}
		case "user":
			return `@${item.plain_text}`;
		case "link_preview":
			return `[${item.plain_text}](${mention.link_preview.url})`;
		default:
			return item.plain_text;
	}
}

async function convertTable(
	block: BlockObjectResponse & { type: "table" },
	ctx: ConvertContext
): Promise<string> {
	const rows = await fetchAllChildren(ctx.client, block.id);
	if (rows.length === 0) return "";

	const lines: string[] = [];
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (row.type !== "table_row") continue;
		const cells = row.table_row.cells.map((cell) => convertRichText(cell));
		lines.push(`| ${cells.join(" | ")} |`);
		if (i === 0) {
			lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
		}
	}
	return lines.join("\n");
}

async function convertColumnList(
	block: BlockObjectResponse & { type: "column_list" },
	ctx: ConvertContext
): Promise<string> {
	const columns = await fetchAllChildren(ctx.client, block.id);
	const parts: string[] = [];
	for (const col of columns) {
		if (col.type !== "column") continue;
		const children = await fetchAllChildren(ctx.client, col.id);
		const md = await convertBlocksToMarkdown(children, ctx);
		if (md) parts.push(md);
	}
	return parts.join("\n\n---\n\n");
}

function emojiToCalloutType(
	icon: { type: string; emoji?: string } | null
): string {
	if (!icon || icon.type !== "emoji" || !icon.emoji) return "info";

	const map: Record<string, string> = {
		"💡": "tip",
		"⚠️": "warning",
		"❗": "danger",
		"❓": "question",
		"📝": "note",
		"🔥": "danger",
		"✅": "success",
		"📌": "important",
		"🚨": "danger",
		"💀": "danger",
		"🐛": "bug",
		"📖": "quote",
		"💬": "quote",
		"🗣️": "quote",
		"ℹ️": "info",
		"📋": "abstract",
		"🎯": "example",
		"🔗": "info",
	};

	return map[icon.emoji] || "info";
}
