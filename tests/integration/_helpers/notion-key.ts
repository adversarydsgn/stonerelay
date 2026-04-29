import { readFile } from "node:fs/promises";

const PLUGIN_DATA_PATH = "/Users/adversary/Documents/Obsidian Vaults/adversary/.obsidian/plugins/stonerelay/data.json";

export async function readIntegrationNotionApiKey(env: NodeJS.ProcessEnv = process.env): Promise<string> {
	const fromEnv = env.NOTION_API_KEY?.trim();
	if (fromEnv) return fromEnv;

	const raw = await readFile(PLUGIN_DATA_PATH, "utf8");
	const parsed = JSON.parse(raw) as { apiKey?: unknown };
	const apiKey = typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "";
	if (!apiKey) {
		throw new Error(`NOTION_API_KEY is required, and no apiKey was found in ${PLUGIN_DATA_PATH}.`);
	}
	return apiKey;
}
