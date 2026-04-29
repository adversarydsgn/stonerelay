import { describe, expect, it } from "vitest";
import { buildVaultCanonicalDiagnosticsRow } from "../src/vault-canonical";
import { database } from "./vault-canonical-test-helpers";

describe("vault canonical mid-bootstrap detection", () => {
	it("marks .next-id present with no mirror property as mid-bootstrap", () => {
		const row = buildVaultCanonicalDiagnosticsRow({
			entry: database({ canonical_id_property: null }),
			folderPath: "_relay/A",
			state: { nextId: 462, nextIdRaw: "462\n", nextIdPresent: true, nextIdParseError: null, lockPresent: false, nextIdMtime: null },
			awaitingStampCount: 0,
		});

		expect(row?.midBootstrap).toBe(true);
	});
});
