import { describe, expect, it, vi } from "vitest";
import NotionFreezePlugin from "../src/main";

describe("plugin onload capability smoke", () => {
	it.each([
		["write+rename", { write: vi.fn(async () => undefined), rename: vi.fn(async () => undefined) }],
		["write only", { write: vi.fn(async () => undefined) }],
		["neither write nor rename", {}],
	])("does not throw with adapter capability variant %s", async (_label, adapter) => {
		const plugin = new NotionFreezePlugin();
		plugin.app = appMock(adapter) as never;
		await expect(plugin.onload()).resolves.toBeUndefined();
	});
});

function appMock(adapter: Record<string, unknown>) {
	return {
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
	};
}
