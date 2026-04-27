import { Client } from "@notionhq/client";
import { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints";
import { App } from "obsidian";
import { PageSyncEntry } from "./types";
import { notionRequest } from "./notion-client";
import { writeStandalonePage } from "./page-writer";

export async function fetchStandalonePageMetadata(
	client: Client,
	pageId: string
): Promise<PageObjectResponse> {
	const page = await notionRequest(() => client.pages.retrieve({ page_id: pageId }));
	if (page.object !== "page" || !("properties" in page)) {
		throw new Error("Notion object is not a page.");
	}
	return page as PageObjectResponse;
}

export async function importStandalonePage(
	app: App,
	client: Client,
	pageId: string,
	outputFolder: string
): Promise<{ filePath: string; title: string; page: PageObjectResponse }> {
	const page = await fetchStandalonePageMetadata(client, pageId);
	const result = await writeStandalonePage(app, {
		client,
		page,
		outputFolder,
	});
	return { filePath: result.filePath, title: result.title, page };
}

export async function refreshStandalonePage(
	app: App,
	client: Client,
	entry: PageSyncEntry
): Promise<{ filePath: string; title: string; page: PageObjectResponse }> {
	return importStandalonePage(app, client, entry.pageId, entry.outputFolder);
}
