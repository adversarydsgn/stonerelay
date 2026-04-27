import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildBratStatus,
	clearBratStatusCache,
	fetchLatestGithubRelease,
	unavailableBratStatus,
} from "../src/brat-status";

function fetchRelease(version: string) {
	return vi.fn(async () => ({
		ok: true,
		json: async () => ({
			tag_name: `v${version}`,
			published_at: "2026-04-27T16:00:00Z",
			assets: [
				{ name: "main.js" },
				{ name: "manifest.json" },
				{ name: "styles.css" },
			],
		}),
	})) as never;
}

describe("BRAT install status", () => {
	beforeEach(() => {
		clearBratStatusCache();
	});

	it("renders Up to date when installed matches the latest release", async () => {
		const release = await fetchLatestGithubRelease({ fetchImpl: fetchRelease("0.9.6") });

		expect(buildBratStatus("0.9.6", release)).toMatchObject({
			kind: "ready",
			label: "Up to date",
			tone: "green",
		});
	});

	it("renders Update available when GitHub has a newer release", async () => {
		const release = await fetchLatestGithubRelease({ fetchImpl: fetchRelease("0.9.7") });

		expect(buildBratStatus("0.9.6", release)).toMatchObject({
			kind: "ready",
			label: "Update available: v0.9.7 (published 2026-04-27T16:00:00Z)",
			tone: "yellow",
		});
	});

	it("renders Status unavailable for network errors", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("offline");
		}) as never;

		await expect(fetchLatestGithubRelease({ fetchImpl })).rejects.toThrow("offline");
		expect(unavailableBratStatus()).toEqual({
			kind: "unavailable",
			label: "Status unavailable",
		});
	});

	it("caches latest release fetches for one hour", async () => {
		const fetchImpl = fetchRelease("0.9.6");

		await fetchLatestGithubRelease({ fetchImpl, now: 1000 });
		await fetchLatestGithubRelease({ fetchImpl, now: 2000 });

		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});
