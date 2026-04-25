import { Client } from "@notionhq/client";
import { BlockObjectResponse } from "@notionhq/client/build/src/api-endpoints";
import { describe, expect, test } from "vitest";
import { convertBlocksToMarkdown } from "../src/block-converter";

describe("heading block conversion", () => {
	test("heading_1 converts to # markdown", async () => {
		await expectHeading("heading_1", "Title", "# Title");
	});

	test("heading_2 converts to ## markdown", async () => {
		await expectHeading("heading_2", "Title", "## Title");
	});

	test("heading_3 converts to ### markdown", async () => {
		await expectHeading("heading_3", "Title", "### Title");
	});

	test("heading_4 converts to #### markdown", async () => {
		await expectHeading("heading_4", "Title", "#### Title");
	});

	test("heading_5 converts to ##### markdown", async () => {
		await expectHeading("heading_5", "Title", "##### Title");
	});

	test("heading_6 converts to ###### markdown", async () => {
		await expectHeading("heading_6", "Title", "###### Title");
	});

	test("heading with multiple rich_text items concatenates", async () => {
		const markdown = await convertBlocksToMarkdown([
			headingBlock("heading_4", ["Hello ", "World"]),
		], testContext());

		expect(markdown).toContain("#### Hello World");
	});

	test("heading with empty rich_text emits hashes only", async () => {
		const markdown = await convertBlocksToMarkdown([
			headingBlock("heading_5", []),
		], testContext());

		expect(markdown).toContain("##### ");
	});
});

async function expectHeading(type: string, text: string, expected: string) {
	const markdown = await convertBlocksToMarkdown([
		headingBlock(type, [text]),
	], testContext());

	expect(markdown).toContain(expected);
}

function headingBlock(type: string, plainTexts: string[]): BlockObjectResponse {
	return {
		object: "block",
		id: `${type}-test`,
		parent: { type: "page_id", page_id: "page-1" },
		created_time: "2026-04-25T00:00:00.000Z",
		last_edited_time: "2026-04-25T00:00:00.000Z",
		created_by: { object: "user", id: "user-1" },
		last_edited_by: { object: "user", id: "user-1" },
		has_children: false,
		archived: false,
		in_trash: false,
		type,
		[type]: {
			rich_text: plainTexts.map(richText),
			color: "default",
			is_toggleable: false,
		},
	} as unknown as BlockObjectResponse;
}

function richText(content: string) {
	return {
		type: "text",
		plain_text: content,
		text: {
			content,
			link: null,
		},
		annotations: {
			bold: false,
			italic: false,
			strikethrough: false,
			underline: false,
			code: false,
			color: "default",
		},
		href: null,
	};
}

function testContext() {
	return {
		client: {} as Client,
		indentLevel: 0,
	};
}
