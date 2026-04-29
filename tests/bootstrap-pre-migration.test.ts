import { describe, expect, it } from "vitest";
import { buildVaultCanonicalDiagnosticsRow } from "../src/vault-canonical";
import { database } from "./vault-canonical-test-helpers";

describe("vault canonical pre-migration", () => {
	it("has no diagnostics row when .next-id and canonical_id_property are both absent", () => {
		expect(buildVaultCanonicalDiagnosticsRow({
			entry: database(),
			folderPath: "_relay/A",
			state: { nextId: null, nextIdRaw: null, nextIdPresent: false, nextIdParseError: null, lockPresent: false, nextIdMtime: null },
			awaitingStampCount: 0,
		})).toBeNull();
	});
});
