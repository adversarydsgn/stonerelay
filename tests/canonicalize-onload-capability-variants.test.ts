import { describe, expect, it, vi } from "vitest";
import NotionFreezePlugin from "../src/main";

describe("canonicalization runtime smoke", () => {
	it.each([
		["capability-A write+rename", { write: vi.fn(async () => undefined), rename: vi.fn(async () => undefined) }],
		["capability-B write only", { write: vi.fn(async () => undefined) }],
	])("loads without throwing under %s", async (_label, adapter) => {
		const plugin = new NotionFreezePlugin();
		plugin.app = {
			vault: {
				adapter,
				on: vi.fn(() => ({})),
				getAbstractFileByPath: vi.fn(() => null),
				getMarkdownFiles: vi.fn(() => []),
			},
			metadataCache: {
				getFileCache: vi.fn(() => ({ frontmatter: {} })),
			},
			workspace: {
				on: vi.fn(() => ({})),
				trigger: vi.fn(),
			},
		} as never;

		await expect(plugin.onload()).resolves.toBeUndefined();
	});
});
