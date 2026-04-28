import { describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import { AtomicWriteUnavailableError, modifyAtomic, writeAtomic } from "../src/atomic-vault-write";

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
