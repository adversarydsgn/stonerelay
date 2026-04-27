export const BRAT_RELEASE_REPO = "adversarydsgn/stonerelay";
export const BRAT_RELEASE_URL = `https://api.github.com/repos/${BRAT_RELEASE_REPO}/releases/latest`;
export const BRAT_STATUS_CACHE_MS = 60 * 60 * 1000;

export interface BratReleaseAsset {
	name: string;
}

export interface BratLatestRelease {
	tagName: string;
	publishedAt: string | null;
	assets: BratReleaseAsset[];
}

export type BratStatusState =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "ready"; release: BratLatestRelease; label: string; tone: "green" | "yellow" }
	| { kind: "unavailable"; label: string };

interface CachedRelease {
	fetchedAt: number;
	release: BratLatestRelease;
}

let cachedRelease: CachedRelease | null = null;

export function getInstalledPluginVersion(app: unknown, fallbackVersion: string): string {
	const manifests = (app as { plugins?: { manifests?: Record<string, { version?: string }> } })?.plugins?.manifests;
	return manifests?.stonerelay?.version ?? fallbackVersion;
}

export async function fetchLatestGithubRelease(
	options: {
		fetchImpl?: typeof fetch;
		force?: boolean;
		now?: number;
	} = {}
): Promise<BratLatestRelease> {
	const now = options.now ?? Date.now();
	if (!options.force && cachedRelease && now - cachedRelease.fetchedAt < BRAT_STATUS_CACHE_MS) {
		return cachedRelease.release;
	}
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	if (!fetchImpl) throw new Error("fetch unavailable");
	const response = await fetchImpl(BRAT_RELEASE_URL, {
		headers: { Accept: "application/vnd.github+json" },
	});
	if (!response.ok) throw new Error(`GitHub release lookup failed: ${response.status}`);
	const payload = await response.json() as {
		tag_name?: string;
		published_at?: string | null;
		assets?: Array<{ name?: string }>;
	};
	const release = {
		tagName: payload.tag_name ?? "unknown",
		publishedAt: payload.published_at ?? null,
		assets: (payload.assets ?? []).map((asset) => ({ name: asset.name ?? "unnamed asset" })),
	};
	cachedRelease = { fetchedAt: now, release };
	return release;
}

export function buildBratStatus(installedVersion: string, release: BratLatestRelease): BratStatusState {
	const latest = release.tagName.replace(/^v/, "");
	const comparison = compareSemver(installedVersion, latest);
	if (comparison >= 0) {
		return { kind: "ready", release, label: "Up to date", tone: "green" };
	}
	return {
		kind: "ready",
		release,
		label: `Update available: ${release.tagName}${release.publishedAt ? ` (published ${release.publishedAt})` : ""}`,
		tone: "yellow",
	};
}

export function unavailableBratStatus(): BratStatusState {
	return { kind: "unavailable", label: "Status unavailable" };
}

export function clearBratStatusCache(): void {
	cachedRelease = null;
}

export function renderBratStatusPanel(
	containerEl: HTMLElement,
	installedVersion: string,
	state: BratStatusState,
	onCheck: () => void
): void {
	const panel = containerEl.createDiv({ cls: "stonerelay-brat-status-panel" });
	panel.createEl("h3", { text: "BRAT / install status" });
	panel.createEl("p", { text: `Installed version: ${installedVersion}` });
	const statusText = state.kind === "ready"
		? state.label
		: state.kind === "loading"
			? "Checking latest release..."
			: state.kind === "unavailable"
				? state.label
				: "Status unavailable";
	panel.createEl("p", { text: statusText });
	if (state.kind === "ready") {
		panel.createEl("p", { text: `Latest GitHub release: ${state.release.tagName}` });
		panel.createEl("p", { text: `Assets: ${state.release.assets.map((asset) => asset.name).join(", ") || "none"}` });
	}
	const button = panel.createEl("button", { text: "Check for updates" });
	button.type = "button";
	button.onClickEvent(onCheck);
}

function compareSemver(left: string, right: string): number {
	const leftParts = left.split(".").map((part) => Number(part));
	const rightParts = right.split(".").map((part) => Number(part));
	for (let i = 0; i < 3; i++) {
		const diff = (leftParts[i] || 0) - (rightParts[i] || 0);
		if (diff !== 0) return diff;
	}
	return 0;
}
