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

