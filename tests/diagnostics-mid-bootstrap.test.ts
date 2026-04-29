import { describe, expect, it } from "vitest";
import { renderDiagnosticsPanel } from "../src/diagnostics-panel";
import { database, fakeElement, flattenText, settings } from "./vault-canonical-test-helpers";

describe("vault canonical diagnostics mid-bootstrap", () => {
	it("renders mid-bootstrap state", () => {
		const root = fakeElement("root");
		renderDiagnosticsPanel(root as never, settings([database()]), {
			vaultCanonicalRows: [{
				entryId: "db-1",
				name: "Bugs DB",
				mirrorProperty: null,
				nextIdValue: 462,
				nextIdPresent: true,
				nextIdParseError: null,
				lockPresent: false,
				nextIdMtime: null,
				lastObservedUniqueIdMax: null,
				sequenceLag: false,
				awaitingStampCount: 0,
				midBootstrap: true,
			}],
		});

		expect(flattenText(root).join("\n")).toContain("Mid-bootstrap detected");
	});
});
