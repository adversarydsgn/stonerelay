import { describe, expect, it } from "vitest";
import { readVaultCanonicalState } from "../src/vault-canonical";
import { pullApp } from "./vault-canonical-test-helpers";

describe("lockfile read diagnostics", () => {
	it("reads bare-integer .next-id without acquiring a lock", async () => {
		const app = pullApp([], [["_relay/A/.next-id", "462\n"]]);
		const state = await readVaultCanonicalState(app.vault.adapter, "_relay/A");

		expect(state.nextId).toBe(462);
		expect(app.vault.adapter.write).not.toHaveBeenCalled();
	});
});
