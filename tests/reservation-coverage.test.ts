import { readFileSync } from "fs";
import { describe, expect, it, vi } from "vitest";
import { USER_ACTION_AUDIT } from "../src/action-audit";
import { freshDatabaseImport, refreshDatabase } from "../src/database-freezer";
import { pushDatabase } from "../src/push";

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
			expect(actions).toContain("Vault canonical mirror written (Push create)");
			expect(actions).toContain("Vault canonical lockfile read");
		});

	it("behaviorally blocks direct push helper calls before Notion access without a reservation", async () => {
		const client = { databases: { retrieve: vi.fn() } };

		await expect(pushDatabase({} as never, client as never, "db-1", "_relay"))
			.rejects.toThrow("Reservation required before database push");
		expect(client.databases.retrieve).not.toHaveBeenCalled();
	});

	it("behaviorally blocks direct pull helper calls before Notion access without a reservation", async () => {
		const client = { databases: { retrieve: vi.fn() } };

		await expect(freshDatabaseImport({} as never, client as never, "db-1", "_relay"))
			.rejects.toThrow("Reservation required before fresh database import");
		await expect(refreshDatabase({} as never, client as never, {
			databaseId: "db-1",
			title: "DB",
			folderPath: "_relay",
			entryCount: 0,
		}))
			.rejects.toThrow("Reservation required before database refresh");
		expect(client.databases.retrieve).not.toHaveBeenCalled();
	});
});

function read(path: string): string {
	return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}
