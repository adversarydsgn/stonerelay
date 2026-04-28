import { Client } from "@notionhq/client";
import { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints";
import { App } from "obsidian";
import { PageSyncEntry, SyncRunOptions } from "./types";
import { notionRequest } from "./notion-client";
import { writeStandalonePage } from "./page-writer";
import type { ReservationContext } from "./reservations";

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
	outputFolder: string,
	options: SyncRunOptions = {}
): Promise<{ filePath: string; title: string; page: PageObjectResponse }> {
	requireReservation(options.context, "standalone page import");
	const page = await fetchStandalonePageMetadata(client, pageId);
	const result = await writeStandalonePage(app, {
		client,
		page,
		outputFolder,
		context: options.context,
		onAtomicWriteCommitted: options.onAtomicWriteCommitted,
	});
	return { filePath: result.filePath, title: result.title, page };
}

export async function refreshStandalonePage(
	app: App,
	client: Client,
	entry: PageSyncEntry,
	options: SyncRunOptions = {}
): Promise<{ filePath: string; title: string; page: PageObjectResponse }> {
	return importStandalonePage(app, client, entry.pageId, entry.outputFolder, options);
}

function requireReservation(context: ReservationContext | undefined, writer: string): void {
	if (!context?.id) {
		throw new Error(`Reservation required before ${writer}.`);
	}
}
