import { describe, expect, it } from "vitest";
import { renderDiagnosticsPanel } from "../src/diagnostics-panel";
import { database, fakeElement, flattenText, settings } from "./vault-canonical-test-helpers";

describe("vault canonical diagnostics lock sentinel", () => {
	it("renders .next-id.lock as informational", () => {
		const root = fakeElement("root");
		renderDiagnosticsPanel(root as never, settings([database({ canonical_id_property: "Canonical ID" })]), {
			vaultCanonicalRows: [{
				entryId: "db-1",
				name: "Bugs DB",
				mirrorProperty: "Canonical ID",
				nextIdValue: 462,
				nextIdPresent: true,
				nextIdParseError: null,
				lockPresent: true,
				nextIdMtime: null,
				lastObservedUniqueIdMax: null,
				sequenceLag: false,
				awaitingStampCount: 0,
				midBootstrap: false,
			}],
		});

		expect(flattenText(root).join("\n")).toContain(".next-id.lock: present (informational)");
	});
});
