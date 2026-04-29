import { describe, expect, it } from "vitest";
import { renderDiagnosticsPanel } from "../src/diagnostics-panel";
import { database, fakeElement, flattenText, settings } from "./vault-canonical-test-helpers";

describe("vault canonical diagnostics sequence lag", () => {
	it("renders sequence-lag warning", () => {
		const root = fakeElement("root");
		renderDiagnosticsPanel(root as never, settings([database({ canonical_id_property: "Canonical ID" })]), {
			vaultCanonicalRows: [row({ sequenceLag: true, lastObservedUniqueIdMax: 462 })],
		});

		expect(flattenText(root).join("\n")).toContain("Sequence lag");
	});
});

function row(overrides = {}) {
	return {
		entryId: "db-1",
		name: "Bugs DB",
		mirrorProperty: "Canonical ID",
		nextIdValue: 462,
		nextIdPresent: true,
		nextIdParseError: null,
		lockPresent: false,
		nextIdMtime: null,
		lastObservedUniqueIdMax: 461,
		sequenceLag: false,
		awaitingStampCount: 0,
		midBootstrap: false,
		...overrides,
	};
}
