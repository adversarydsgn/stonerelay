import { describe, expect, it } from "vitest";
import { readVaultCanonicalState } from "../src/vault-canonical";
import { pullApp } from "./vault-canonical-test-helpers";

describe("lockfile concurrent read", () => {
	it("reports identical .next-id values for simultaneous read-only diagnostics", async () => {
		const app = pullApp([], [["_relay/A/.next-id", "462\n"]]);
		const states = await Promise.all([
			readVaultCanonicalState(app.vault.adapter, "_relay/A"),
			readVaultCanonicalState(app.vault.adapter, "_relay/A"),
		]);

		expect(states.map((state) => state.nextId)).toEqual([462, 462]);
		expect(app.vault.adapter.write).not.toHaveBeenCalled();
	});
});
