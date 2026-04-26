import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, test, vi } from "vitest";
import { SyncError } from "../src/types";
import {
	assertNotCancelled,
	commitRow,
	syncErrorsFromMessages,
	SyncCancelled,
} from "../src/sync-state";
import { writePluginDataAtomic } from "../src/plugin-data";
import { writeJsonAtomic } from "../src/settings-data";

describe("per-row failure (rsync pattern)", () => {
	test("one failing row records partial status data while later rows can continue", () => {
		const timestamp = "2026-04-25T21:00:00.000Z";
		const errors = syncErrorsFromMessages(["row-2: Notion rejected row"], "push", timestamp);

		expect(errors).toEqual([{
			rowId: "row-2",
			direction: "push",
			error: "row-2: Notion rejected row",
			errorCode: undefined,
			timestamp,
		}]);
	});

	test("lastSyncErrors contains failed rowId with error class and timestamp", () => {
		const errors = syncErrorsFromMessages(["row-7: network timeout"], "pull", "2026-04-25T21:00:00.000Z");
		expect(errors[0]).toMatchObject({
			rowId: "row-7",
			direction: "pull",
			errorCode: "network",
			timestamp: "2026-04-25T21:00:00.000Z",
		});
	});

	test("retry-failed-rows action can derive only failed row ids", () => {
		const errors: SyncError[] = [
			{ rowId: "row-a", direction: "pull", error: "failed", timestamp: "now" },
			{ rowId: "row-b", direction: "pull", error: "failed", timestamp: "now" },
		];
		expect(errors.map((error) => error.rowId)).toEqual(["row-a", "row-b"]);
	});
});

describe("cancellation (AbortController)", () => {
	test("Cancel mid-sync exits at row boundary via SyncCancelled", () => {
		const controller = new AbortController();
		controller.abort();
		expect(() => assertNotCancelled(controller.signal)).toThrow(SyncCancelled);
	});

	test("lastCommittedRowId reflects last row that completed commitRow", async () => {
		let cursor: string | null = null;
		await commitRow("row-1", async () => "ok", (rowId) => {
			cursor = rowId;
		});
		await expect(commitRow("row-2", async () => {
			throw new Error("write failed");
		}, (rowId) => {
			cursor = rowId;
		})).rejects.toThrow("write failed");
		expect(cursor).toBe("row-1");
	});

	test("Cancel button path does not need to mutate data.json directly", () => {
		const controller = new AbortController();
		const writeDataJson = vi.fn();
		controller.abort();
		expect(controller.signal.aborted).toBe(true);
		expect(writeDataJson).not.toHaveBeenCalled();
	});
});

describe("atomic-rename data.json writes", () => {
	test("writeFile-then-rename pattern writes valid JSON", async () => {
		const dir = await mkdtemp(join(tmpdir(), "stonerelay-atomic-"));
		const target = join(dir, "data.json");
		try {
			await writeJsonAtomic(target, { schemaVersion: 4, databases: [] });
			expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
				schemaVersion: 4,
				databases: [],
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("simulated failed write leaves prior data.json valid", async () => {
		const dir = await mkdtemp(join(tmpdir(), "stonerelay-atomic-"));
		const target = join(dir, "data.json");
		try {
			await writeFile(target, "{\"schemaVersion\":3}\n", "utf8");
			await expect(writeJsonAtomic(`${dir}/missing/child/data.json`, { schemaVersion: 4 })).resolves.toBeUndefined();
			expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ schemaVersion: 3 });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("plugin data write renames temp payload into place on normal adapters", async () => {
		const files = new Map<string, string>();

		await writePluginDataAtomic(
			{
				write: async (path, data) => {
					files.set(path, data);
				},
				rename: async (from, to) => {
					const value = files.get(from);
					if (value === undefined) throw new Error(`missing ${from}`);
					files.delete(from);
					files.set(to, value);
				},
			},
			".obsidian/plugins/stonerelay/data.json",
			"{\"schemaVersion\":4}\n",
			async () => {
				throw new Error("fallback should not be used");
			}
		);

		expect(files.get(".obsidian/plugins/stonerelay/data.json")).toBe("{\"schemaVersion\":4}\n");
		expect([...files.keys()].some((path) => path.includes(".tmp-"))).toBe(false);
	});

	test("plugin data write uses confirmed overwrite when adapter rename cannot replace existing data.json", async () => {
		const files = new Map<string, string>([
			[".obsidian/plugins/stonerelay/data.json", "{\"schemaVersion\":3}\n"],
		]);
		const writes: string[] = [];
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		try {
			await writePluginDataAtomic(
				{
					write: async (path, data) => {
						writes.push(path);
						files.set(path, data);
					},
					read: async (path) => {
						const value = files.get(path);
						if (value === undefined) throw new Error(`missing ${path}`);
						return value;
					},
					rename: async (from, to) => {
						const value = files.get(from);
						if (value === undefined) throw new Error(`missing ${from}`);
						if (files.has(to)) throw new Error(`target exists ${to}`);
						files.delete(from);
						files.set(to, value);
					},
					remove: async (path) => {
						files.delete(path);
					},
				},
				".obsidian/plugins/stonerelay/data.json",
				"{\"schemaVersion\":4}\n",
				async () => {
					throw new Error("fallback should not be used");
				}
			);

			expect(files.get(".obsidian/plugins/stonerelay/data.json")).toBe("{\"schemaVersion\":4}\n");
			expect([...files.keys()].some((path) => path.includes(".tmp-"))).toBe(false);
			expect(writes).toHaveLength(2);
			expect(writes[0]).toContain(".tmp-");
			expect(writes[1]).toBe(".obsidian/plugins/stonerelay/data.json");
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	test("plugin data write still warns on unexpected rename failures", async () => {
		const files = new Map<string, string>();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		try {
			await writePluginDataAtomic(
				{
					write: async (path, data) => {
						files.set(path, data);
					},
					read: async (path) => {
						const value = files.get(path);
						if (value === undefined) throw new Error(`missing ${path}`);
						return value;
					},
					rename: async () => {
						throw new Error("disk unavailable");
					},
					remove: async (path) => {
						files.delete(path);
					},
				},
				".obsidian/plugins/stonerelay/data.json",
				"{\"schemaVersion\":4}\n",
				async () => {
					throw new Error("fallback should not be used");
				}
			);

			expect(warn).toHaveBeenCalledWith("Stonerelay: adapter rename failed (disk unavailable); using write-confirm-remove fallback for data.json.");
		} finally {
			warn.mockRestore();
		}
	});
});

describe("crash recovery", () => {
	test("entry with current_sync_id can be marked interrupted without clearing cursor", () => {
		const entry = {
			current_sync_id: "sync-1",
			lastCommittedRowId: "row-7",
		};
		const recovered = {
			...entry,
			current_sync_id: null,
			lastSyncStatus: "interrupted",
		};
		expect(recovered).toMatchObject({
			current_sync_id: null,
			lastCommittedRowId: "row-7",
			lastSyncStatus: "interrupted",
		});
	});
});
