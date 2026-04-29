import { describe, expect, it, vi } from "vitest";
import NotionFreezePlugin from "../src/main";
import { database, settings } from "./vault-canonical-test-helpers";

describe("vault canonical runtime smoke", () => {
	it.each([
		["feature-off", settings([database()]), new Map<string, string>()],
		["fully migrated", settings([database({ canonical_id_property: "Canonical ID" })]), new Map([["_relay/A/.next-id", "462\n"]])],
		["mid-bootstrap", settings([database()]), new Map([["_relay/A/.next-id", "462\n"]])],
	])("onload does not throw for %s", async (_label, data, files) => {
		const plugin = new NotionFreezePlugin();
		plugin.loadData = async () => data;
		plugin.app = {
			vault: {
				adapter: {
					files,
					write: vi.fn(async (path: string, value: string) => files.set(path, value)),
					read: vi.fn(async (path: string) => files.get(path) ?? ""),
					rename: vi.fn(async (from: string, to: string) => {
						files.set(to, files.get(from) ?? "");
						files.delete(from);
					}),
					remove: vi.fn(async (path: string) => files.delete(path)),
				},
				on: vi.fn(() => ({})),
				getAbstractFileByPath: vi.fn(() => null),
				getMarkdownFiles: vi.fn(() => []),
			},
			metadataCache: { getFileCache: vi.fn(() => ({ frontmatter: {} })) },
			workspace: { on: vi.fn(() => ({})), trigger: vi.fn() },
		} as never;

		await expect(plugin.onload()).resolves.toBeUndefined();
	});
});
