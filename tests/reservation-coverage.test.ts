import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { USER_ACTION_AUDIT } from "../src/action-audit";

describe("reservation and atomic-write coverage audit", () => {
	it("documents the writer audit trail for reservation-protected entry points", () => {
		const main = read("src/main.ts");
		const pushOneStart = main.indexOf("async pushOneConfiguredDatabase");
		const pushOneEnd = main.indexOf("async retryFailedRows");
		const pushOne = main.slice(pushOneStart, pushOneEnd);

		expect(pushOne).toContain("run = await this.beginSync(entry, type, retryRowIds, \"push\", \"manual\", sourceFolder)");
		expect(pushOne.indexOf("run = await this.beginSync(entry, type, retryRowIds, \"push\", \"manual\", sourceFolder)"))
			.toBeLessThan(pushOne.indexOf("const confirmed = await this.confirmStaleIdThresholdIfNeeded(entry, sourceFolder)"));
		expect(main).toContain("await this.beginSync(entry, \"full\", undefined, \"pull\", \"batch\"");
		expect(main).toContain("await this.beginSync(entry, \"full\", undefined, \"push\", \"batch\"");
		expect(main.indexOf("const unsafe = this.pullSafetyBlocker(entry);"))
			.toBeLessThan(main.indexOf("await this.beginSync(entry, \"full\", undefined, \"pull\", \"batch\""));
		expect(main).toContain("this.reservations.acquire({");
	});

	it("keeps direct vault content writes out of source modules outside the atomic helper", () => {
		for (const source of ["src/page-writer.ts", "src/database-freezer.ts", "src/push.ts"]) {
			expect(read(source)).not.toMatch(/vault\.(modify|create)\(/);
		}
	});

	it("records reservation, push-intent, and atomic-write events in the action audit", () => {
		const actions = USER_ACTION_AUDIT.map((row) => row.action);
		expect(actions).toContain("Reservation acquired");
		expect(actions).toContain("Reservation released");
		expect(actions).toContain("Reservation rejected (key conflict)");
		expect(actions).toContain("Reservation queued (batch op)");
		expect(actions).toContain("Push intent recorded");
		expect(actions).toContain("Push intent recovered (startup)");
		expect(actions).toContain("Atomic write committed");
	});
});

function read(path: string): string {
	return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}
