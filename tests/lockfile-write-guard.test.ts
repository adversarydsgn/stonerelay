import { describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import { LockfileWriteForbiddenError, writeAtomic, modifyAtomic } from "../src/atomic-vault-write";

describe("lockfile write guard", () => {
	it("rejects writes to .next-id and .next-id.lock", async () => {
		const vault = { adapter: { write: vi.fn() } };
		await expect(writeAtomic(vault, "_relay/A/.next-id", "462\n")).rejects.toBeInstanceOf(LockfileWriteForbiddenError);
		const file = Object.assign(Object.create(TFile.prototype), { path: "_relay/A/.next-id.lock" });
		await expect(modifyAtomic(vault, file, "")).rejects.toBeInstanceOf(LockfileWriteForbiddenError);
		expect(vault.adapter.write).not.toHaveBeenCalled();
	});
});
