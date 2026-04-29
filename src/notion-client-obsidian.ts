import { requestUrl } from "obsidian";
import type { Client } from "@notionhq/client";
import { createNotionClient } from "./notion-client";

export function createObsidianNotionClient(apiKey: string): Client {
	return createNotionClient(apiKey, { fetch: obsidianFetch });
}

async function obsidianFetch(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const urlString = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
	const response = await requestUrl({
		url: urlString,
		method: init?.method || "GET",
		headers: init?.headers as Record<string, string>,
		body: init?.body as string | ArrayBuffer,
		throw: false,
	});
	return new Response(response.arrayBuffer, {
		status: response.status,
		statusText: response.status.toString(),
		headers: new Headers(response.headers),
	});
}
