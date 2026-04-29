import { describe, expect, it } from "vitest";
import { USER_ACTION_AUDIT } from "../src/action-audit";

describe("vault canonical action audit", () => {
	it("records shifted vault canonical actions", () => {
		const actions = USER_ACTION_AUDIT.map((row) => row.action);
		expect(actions).toContain("Vault canonical mirror written (Push create)");
		expect(actions).toContain("Vault canonical mirror written (Push update)");
		expect(actions).toContain("Vault canonical mirror divergence detected");
		expect(actions).toContain("Notion-only row materialized awaiting ID stamp");
		expect(actions).toContain("Notion-only row materialized with mirror ID adopted");
		expect(actions).toContain("Vault canonical sequence-lag warning surfaced");
		expect(actions).toContain("Vault canonical lockfile read");
	});
});
