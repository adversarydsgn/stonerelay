import { describe, expect, it } from "vitest";
import { readVaultCanonicalState } from "../src/vault-canonical";
import { pullApp } from "./vault-canonical-test-helpers";

describe("lockfile sentinel informational status", () => {
	it("surfaces .next-id.lock presence without parse error", async () => {
		const app = pullApp([], [["_relay/A/.next-id", "462\n"], ["_relay/A/.next-id.lock", ""]]);
		const state = await readVaultCanonicalState(app.vault.adapter, "_relay/A");

		expect(state.lockPresent).toBe(true);
		expect(state.nextIdParseError).toBeNull();
	});
});
