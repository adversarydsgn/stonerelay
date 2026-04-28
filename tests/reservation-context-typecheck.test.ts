import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("ReservationContext type boundary", () => {
	it("rejects bare-string helper contexts at compile time", async () => {
		const tsc = path.join(process.cwd(), "node_modules/.bin/tsc");
		let output = "";

		try {
			await execFileAsync(tsc, [
				"--noEmit",
				"--skipLibCheck",
				"--moduleResolution", "node",
				"--module", "ESNext",
				"--target", "ES2020",
				"--lib", "DOM,ES2020",
				"tests/type-fixtures/reservation-context-bare-string.ts",
			], { cwd: process.cwd() });
		} catch (err) {
			output = `${(err as { stdout?: string }).stdout ?? ""}${(err as { stderr?: string }).stderr ?? ""}`;
		}

		expect(output).toContain("Type 'string' is not assignable to type 'ReservationContext'");
	});
});
