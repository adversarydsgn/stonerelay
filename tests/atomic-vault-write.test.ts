import { describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import { AtomicWriteUnavailableError, modifyAtomic, writeAtomic } from "../src/atomic-vault-write";
import {
	getActiveReservationPathLocks,
	ReservationManager,
	ReservationPathLock,
	RESERVATION_MANAGER_LOCK_KIND,
	RESERVATION_PATH_LOCK_KIND,
} from "../src/reservations";

describe("atomic vault content writes", () => {
	it("commits through temp write plus rename when rename is available", async () => {
		const adapter = memoryAdapter();
		await writeAtomic({ adapter }, "note.md", "new", { onCommitted: (path) => adapter.events.push(`audit:${path}`) });

		expect(adapter.files.get("note.md")).toBe("new");
		expect(adapter.events).toContain("rename:note.md");
		expect(adapter.events).toContain("audit:note.md");
	});

	it("leaves the original note unchanged and cleans temp files when the temp write fails", async () => {
		const adapter = memoryAdapter([["note.md", "original"]]);
		adapter.write = vi.fn(async (path: string, data: string) => {
			if (path.includes(".tmp-")) throw new Error("disk full");
			adapter.files.set(path, data);
		});

		await expect(writeAtomic({ adapter }, "note.md", "new")).rejects.toBeInstanceOf(AtomicWriteUnavailableError);
		expect(adapter.files.get("note.md")).toBe("original");
		expect([...adapter.files.keys()].some((path) => path.includes(".tmp-"))).toBe(false);
	});

	it("uses the write-confirm-remove fallback when rename is absent", async () => {
		const adapter = memoryAdapter([["note.md", "original"]]);
		delete adapter.rename;
		await writeAtomic({ adapter }, "note.md", "new");

		expect(adapter.files.get("note.md")).toBe("new");
		expect([...adapter.files.keys()].some((path) => path.includes(".tmp-"))).toBe(false);
	});

	it("serializes fallback writes to the same file path", async () => {
		const adapter = memoryAdapter([["note.md", "original"]]);
		delete adapter.rename;
		await Promise.all([
			writeAtomic({ adapter }, "note.md", "first"),
			writeAtomic({ adapter }, "note.md", "second"),
		]);

		expect(adapter.files.get("note.md")).toBe("second");
		expect(adapter.events.filter((event) => event === "write:note.md")).toHaveLength(2);
	});

	it("keeps ReservationManager reservations and fallback path locks in separate lock domains", async () => {
		const manager = new ReservationManager();
		const reservation = await manager.acquire({
			entryId: "db-1",
			entryName: "Bugs DB",
			databaseId: "db-1",
			vaultFolder: "_relay/bugs",
			type: "push",
			policy: "manual",
		});
		const renameGate = deferred<void>();
		const renameAdapter = memoryAdapter([["normal.md", "original"]]);
		let sawReservationDuringRename = false;
		renameAdapter.rename = vi.fn(async (from: string, to: string) => {
			sawReservationDuringRename = manager.hasReservation(reservation.id);
			await renameGate.promise;
			const data = renameAdapter.files.get(from);
			if (data === undefined) throw new Error("missing temp");
			renameAdapter.files.set(to, data);
			renameAdapter.files.delete(from);
		});

		const normalWrite = writeAtomic({ adapter: renameAdapter }, "normal.md", "new");
		await vi.waitFor(() => expect(sawReservationDuringRename).toBe(true));
		expect(reservation.lockKind).toBe(RESERVATION_MANAGER_LOCK_KIND);
		expect(getActiveReservationPathLocks()).toEqual([]);
		renameGate.resolve();
		await normalWrite;
		reservation.release();

		const fallbackGate = deferred<void>();
		const fallbackAdapter = memoryAdapter([["fallback.md", "original"]]);
		delete fallbackAdapter.rename;
		let fallbackFinalWriteEntered = false;
		fallbackAdapter.write = vi.fn(async (path: string, data: string) => {
			fallbackAdapter.events.push(`write:${path.includes(".tmp-") ? "tmp" : path}`);
			if (path === "fallback.md") {
				fallbackFinalWriteEntered = true;
				await fallbackGate.promise;
			}
			fallbackAdapter.files.set(path, data);
		});

		const fallbackWrite = writeAtomic({ adapter: fallbackAdapter }, "fallback.md", "fallback");
		await vi.waitFor(() => expect(fallbackFinalWriteEntered).toBe(true));
		const pathLocks = getActiveReservationPathLocks();
		expect(manager.size()).toBe(0);
		expect(pathLocks).toHaveLength(1);
		expect(pathLocks[0]).toBeInstanceOf(ReservationPathLock);
		expect(pathLocks[0].kind).toBe(RESERVATION_PATH_LOCK_KIND);
		expect(pathLocks[0].kind).not.toBe(reservation.lockKind);
		expect(pathLocks[0]).not.toBe(reservation);
		fallbackGate.resolve();
		await fallbackWrite;
		expect(getActiveReservationPathLocks()).toEqual([]);
	});

	it("throws a clear error when neither adapter write nor rename path is available", async () => {
		await expect(writeAtomic({ adapter: {} }, "note.md", "new")).rejects.toThrow("adapter.write is not available");
	});

	it("routes modifyAtomic through the same atomic helper", async () => {
		const adapter = memoryAdapter();
		const file = Object.assign(Object.create(TFile.prototype), { path: "note.md" });
		await modifyAtomic({ adapter }, file, "updated");

		expect(adapter.files.get("note.md")).toBe("updated");
	});
});

function memoryAdapter(initial: Array<[string, string]> = []) {
	const adapter = {
		files: new Map<string, string>(initial),
		events: [] as string[],
		async write(path: string, data: string) {
			adapter.events.push(`write:${path.includes(".tmp-") ? "tmp" : path}`);
			adapter.files.set(path, data);
		},
		async read(path: string) {
			return adapter.files.get(path) ?? "";
		},
		async rename(from: string, to: string) {
			adapter.events.push(`rename:${to}`);
			const data = adapter.files.get(from);
			if (data === undefined) throw new Error("missing temp");
			adapter.files.set(to, data);
			adapter.files.delete(from);
		},
		async remove(path: string) {
			adapter.events.push(`remove:${path.includes(".tmp-") ? "tmp" : path}`);
			adapter.files.delete(path);
		},
	};
	return adapter;
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}
