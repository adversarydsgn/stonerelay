import { describe, expect, it } from "vitest";
import { vaultCanonicalModeActive } from "../src/vault-canonical";
import { database } from "./vault-canonical-test-helpers";

describe("vault canonical fully migrated state", () => {
	it("activates vault-canonical mode when .next-id and mirror property are present", () => {
		expect(vaultCanonicalModeActive(database({ canonical_id_property: "Canonical ID" }), { nextIdPresent: true })).toBe(true);
	});
});
