import { execFile } from "node:child_process";
import { accessSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TFile, TFolder } from "obsidian";
import NotionFreezePlugin from "../../src/main";
import { createNotionClient, notionRequest } from "../../src/notion-client";
import * as notionClientModule from "../../src/notion-client";
import * as notionClientObsidianModule from "../../src/notion-client-obsidian";
import { parseFrontmatter, pushDatabase } from "../../src/push";
import { refreshDatabase } from "../../src/database-freezer";
import { ReservationManager } from "../../src/reservations";
import type { Client } from "@notionhq/client";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints";
import type { SyncedDatabase } from "../../src/types";
import { readIntegrationNotionApiKey } from "./_helpers/notion-key";

const execFileAsync = promisify(execFile);
const VAULT_ROOT = "/Users/adversary/Documents/Obsidian Vaults/adversary";
const VERIFY_TITLE_ROOT = "[STONERELAY-VERIFY-";
const BOOTSTRAP_DIAGNOSTIC =
	"bootstrap migration may not have been run; expected minimum seed values are DEC=461, LOOP=613, FRIC=172, SES=387 as of 2026-04-28";

type FrontmatterValue = string | number | boolean | null;

interface EntityConfig {
	key: "decisions" | "openLoops" | "friction" | "sessions";
	entityName: string;
	shortName: string;
	dataSourceId: string;
	databaseId: string;
	uniqueIdPrefix: string;
	uniqueIdProperty: string;
	titleProperty: string;
	vaultFolder: string;
	expectedSeed: number;
	pushFrontmatter: (title: string, syntheticId: string) => Record<string, FrontmatterValue>;
	pullProperties: (title: string) => Record<string, unknown>;
	expectedWritablePushProperties: Record<string, FrontmatterValue>;
}

const TODAY = "2026-04-29";

const ENTITIES: readonly EntityConfig[] = [
	{
		key: "decisions",
		entityName: "Decisions",
		shortName: "DEC",
		dataSourceId: "e1e832b5-2973-471c-8728-25d36948c628",
		databaseId: "59c159d8-278f-4537-bd5f-cb04640611d9",
		uniqueIdPrefix: "DEC",
		uniqueIdProperty: "ID",
		titleProperty: "Decision",
		vaultFolder: "3. System/Decisions DB",
		expectedSeed: 461,
		pushFrontmatter: (title, syntheticId) => ({
			ID: syntheticId,
			Decision: title,
			"Decided By": "test-harness",
			"Reversal Risk": "Low",
			Context: "Line one for parser fidelity.\nLine two for push propagation.",
			"Date Decided": TODAY,
			"Date Locked": TODAY,
			Status: "LOCKED",
			"Has Signals": false,
			"notion-database-id": "59c159d8-278f-4537-bd5f-cb04640611d9",
		}),
		pullProperties: (title) => ({
			Decision: titleProp(title),
			"Decided By": richTextProp("test-harness"),
			"Reversal Risk": selectProp("Low"),
			Context: richTextProp("Pull line one.\nPull line two."),
			"Date Decided": dateProp(TODAY),
			"Date Locked": dateProp(TODAY),
			Status: selectProp("LOCKED"),
			"Has Signals": checkboxProp(false),
		}),
		expectedWritablePushProperties: {
			"Decided By": "test-harness",
			"Reversal Risk": "Low",
			Context: "Line one for parser fidelity.\nLine two for push propagation.",
			"Date Decided": TODAY,
			"Date Locked": TODAY,
			Status: "LOCKED",
			"Has Signals": false,
		},
	},
	{
		key: "openLoops",
		entityName: "Open Loops",
		shortName: "LOOP",
		dataSourceId: "76e18cb8-5399-41bf-aa9a-162f8881931d",
		databaseId: "0c5a9fe3-665d-4e3e-8d09-4a092e5faa4a",
		uniqueIdPrefix: "LOOP",
		uniqueIdProperty: "ID",
		titleProperty: "Loop",
		vaultFolder: "3. System/Open Loops DB",
		expectedSeed: 613,
		pushFrontmatter: (title, syntheticId) => ({
			ID: syntheticId,
			Loop: title,
			Severity: "🟢 Noted",
			"Date Added": TODAY,
			Scope: "System",
			Status: "Open",
			"Next Action": "Verify first line.\nVerify second line.",
			Exec: "Watson",
			"notion-database-id": "0c5a9fe3-665d-4e3e-8d09-4a092e5faa4a",
		}),
		pullProperties: (title) => ({
			Loop: titleProp(title),
			Severity: selectProp("🟢 Noted"),
			"Date Added": dateProp(TODAY),
			Scope: selectProp("System"),
			Status: selectProp("Open"),
			"Next Action": richTextProp("Pull next action line one.\nPull next action line two."),
			Exec: selectProp("Watson"),
		}),
		expectedWritablePushProperties: {
			Severity: "🟢 Noted",
			"Date Added": TODAY,
			Scope: "System",
			Status: "Open",
			"Next Action": "Verify first line.\nVerify second line.",
			Exec: "Watson",
		},
	},
	{
		key: "friction",
		entityName: "Friction",
		shortName: "FRIC",
		dataSourceId: "ad5864f5-50a3-41fc-8a5b-007d27314fd3",
		databaseId: "62145382-95a0-4a99-998c-f4aab0610796",
		uniqueIdPrefix: "FRIC",
		uniqueIdProperty: "ID",
		titleProperty: "Friction",
		vaultFolder: "3. System/Friction DB",
		expectedSeed: 172,
		pushFrontmatter: (title, syntheticId) => ({
			ID: syntheticId,
			Friction: title,
			"What Happened": "Observed push line one.\nObserved push line two.",
			"What Should Have Happened": "Expected push line one.\nExpected push line two.",
			Date: TODAY,
			Type: "Process",
			Severity: "Minor",
			Skill: "other",
			Resolved: false,
			"notion-database-id": "62145382-95a0-4a99-998c-f4aab0610796",
		}),
		pullProperties: (title) => ({
			Friction: titleProp(title),
			"What Happened": richTextProp("Pull observed line one.\nPull observed line two."),
			"What Should Have Happened": richTextProp("Pull expected line one.\nPull expected line two."),
			Date: dateProp(TODAY),
			Type: selectProp("Process"),
			Severity: selectProp("Minor"),
			Skill: selectProp("other"),
			Resolved: checkboxProp(false),
		}),
		expectedWritablePushProperties: {
			"What Happened": "Observed push line one.\nObserved push line two.",
			"What Should Have Happened": "Expected push line one.\nExpected push line two.",
			Date: TODAY,
			Type: "Process",
			Severity: "Minor",
			Skill: "other",
			Resolved: false,
		},
	},
	{
		key: "sessions",
		entityName: "Sessions",
		shortName: "SES",
		dataSourceId: "f820fd2c-8bba-4fb6-afbe-aa8970f4d168",
		databaseId: "4aa9efae-3e59-4789-90b0-1b67ad3b43a2",
		uniqueIdPrefix: "SES",
		uniqueIdProperty: "Session #",
		titleProperty: "Session",
		vaultFolder: "3. System/Sessions DB",
		expectedSeed: 387,
		pushFrontmatter: (title) => ({
			Session: title,
			"notion-database-id": "4aa9efae-3e59-4789-90b0-1b67ad3b43a2",
		}),
		pullProperties: (title) => ({
			Session: titleProp(title),
			Date: dateProp(TODAY),
			Status: selectProp("Open"),
			Interface: selectProp("Codex"),
			Source: selectProp("Agent"),
		}),
		expectedWritablePushProperties: {},
	},
];

const createdPages: Array<{ entity: EntityConfig; pageId: string }> = [];
const createdFiles = new Set<string>();
let clientPromise: Promise<Client> | null = null;

describe("post-v0.9.10-substrate-lock", () => {
	beforeAll(async () => {
		await sweepAll("preflight");
	}, 120_000);

	afterEach(async () => {
		await cleanupTrackedArtifacts();
	}, 120_000);

	afterAll(async () => {
		await cleanupTrackedArtifacts();
		await sweepAll("afterAll");
		await assertLockfileSeeds();
	}, 180_000);

	it("T1 attests live vault lockfile state without Notion calls", async () => {
		await assertLockfileSeeds();
	});

	for (const entity of ENTITIES) {
		it(`T2 pushes a vault-created ${entity.entityName} row to Notion and cleans it up`, async () => {
			const seed = await readNextId(entity);
			const syntheticId = `${entity.uniqueIdPrefix}-${seed + 9000}`;
			const title = `${verifyPrefix()} ${entity.shortName}-${seed + 9000} round-trip`;
			const filePath = path.join(entity.vaultFolder, `${syntheticId} — ${safeFileName(title)}.md`);
			const frontmatter = entity.pushFrontmatter(title, syntheticId);
			const raw = formatMarkdown(frontmatter, `# ${title}\n\nIntegration push round-trip.`);
			expect(raw).not.toMatch(/:\s*\|\s*$/m);
			expect(raw).not.toMatch(/^[^:\n]+:\s*\[\]\s*$/m);
			await writeVaultFile(filePath, raw);

			let pushedPageId: string | null = null;
			const client = await initClient();
			try {
				const result = await withReservation(entity, "push", (context) =>
					pushDatabase(
						fileBackedApp([filePath]) as never,
						client,
						entity.databaseId,
						entity.vaultFolder,
						{ context, retryRowIds: [filePath] }
					)
				);
				expect(result.failed).toBe(0);
				expect(result.created).toBe(1);

				const matches = await waitForVerifyPages(entity, syntheticId, 1);
				expect(matches).toHaveLength(1);
				pushedPageId = matches[0].id;
				createdPages.push({ entity, pageId: pushedPageId });
				assertPageProperties(matches[0], entity.expectedWritablePushProperties);

				const afterPush = await readVaultFile(filePath);
				const { props } = parseFrontmatter(afterPush);
				expect(props["notion-id"]).toBe(pushedPageId);
				expect(props["notion-url"], "push create backfill should include notion-url").toEqual(expect.any(String));
				expect(props["notion-database-id"], "push create backfill should include notion-database-id").toEqual(entity.databaseId);
				expect(props["notion-last-edited"], "push create backfill should include notion-last-edited").toEqual(expect.any(String));
			} finally {
				if (pushedPageId) await archivePage(pushedPageId);
				await deleteVaultFile(filePath);
				const remaining = await waitForVerifyPages(entity, syntheticId, 0);
				expect(remaining).toHaveLength(0);
			}
		}, 120_000);
	}

	for (const entity of ENTITIES) {
		it(`T3 pulls a Notion-created ${entity.entityName} row to the vault and cleans it up`, async () => {
			const title = `${verifyPrefix()} ${entity.shortName} pull round-trip`;
			const page = await createPage(entity, title);
			await waitForVerifyPages(entity, title, 1);
			const client = await initClient();
			let pulledFilePath: string | null = null;
			try {
				const result = await withReservation(entity, "pull", (context) =>
					refreshDatabase(
						fileBackedApp([]) as never,
						client,
						{
							databaseId: entity.databaseId,
							title: entity.entityName,
							folderPath: entity.vaultFolder,
							entryCount: 0,
						},
						null,
						undefined,
						{ context, retryRowIds: [page.id] }
					)
				);
				expect(result.failed).toBe(0);
				expect(result.created + result.updated).toBeGreaterThanOrEqual(1);

				const matches = await findVaultFiles(entity, VERIFY_TITLE_ROOT);
				const exactMatches = matches.filter((candidate) => candidate.includes(title.replace(/:/g, "-")));
				pulledFilePath = exactMatches[0] ?? matches.find((candidate) => candidate.includes(page.id.replace(/-/g, "").slice(0, 8))) ?? matches[0] ?? null;
				expect(pulledFilePath).toEqual(expect.any(String));
				if (!pulledFilePath) return;

				const raw = await readVaultFile(pulledFilePath);
				const { props } = parseFrontmatter(raw);
				expect(props["notion-id"]).toBe(page.id);
				expect(props["notion-database-id"]).toBe(entity.databaseId);
				expect(props["notion-last-edited"]).toEqual(expect.any(String));
				expect(props[entity.uniqueIdProperty]).toEqual(expect.stringMatching(new RegExp(`^${entity.uniqueIdPrefix}-\\d+$`)));
				if (entity.key === "decisions") {
					expect(props.Status).toBe("LOCKED");
				} else if (entity.key === "openLoops") {
					expect(props.Status).toBe("Open");
				} else if (entity.key === "friction") {
					expect(props.Type).toBe("Process");
					expect(props.Severity).toBe("Minor");
					expect(props.Skill).toBe("other");
					expect(props.Resolved).toBe(false);
				} else {
					expect(props.Status).toBe("Open");
				}
				assertNoEmptyFrontmatterEmissions(raw);
				expect(raw).not.toMatch(/:\s*\|\s*$/m);
			} finally {
				if (pulledFilePath) await deleteVaultFile(pulledFilePath);
				await archivePage(page.id);
				expect(await waitForVerifyPages(entity, title, 0)).toHaveLength(0);
				expect(await findVaultFiles(entity, VERIFY_TITLE_ROOT)).toHaveLength(0);
			}
		}, 180_000);
	}

	it("T4 creates a brand-new manual_merge Decision through the configured push boundary without invoking merge resolution", async () => {
		const entity = ENTITIES[0];
		const title = `${verifyPrefix()} DEC-9999 manual-merge brand-new test`;
		const syntheticId = "DEC-9999";
		const filePath = path.join(entity.vaultFolder, `${syntheticId} — ${safeFileName(title)}.md`);
		await writeVaultFile(filePath, formatMarkdown(entity.pushFrontmatter(title, syntheticId), `# ${title}`));
		let pushedPageId: string | null = null;
		const plugin = new NotionFreezePlugin();
		const reservations = new ReservationManager();
		const app = fileBackedApp([filePath]);
		const entry = syncedDatabase(entity);
		const liveClient = await initClient();
		const createClient = vi.spyOn(notionClientObsidianModule, "createObsidianNotionClient").mockReturnValue(liveClient);
		const conflictResolver = vi.fn();
		plugin.app = app as never;
		plugin.manifest = { id: "stonerelay", version: "0.9.10" } as never;
		plugin.settings = {
			...plugin.settings,
			apiKey: "integration-key-redacted",
			databases: [entry],
			pendingConflicts: [],
		};
		(plugin as unknown as { reservations: ReservationManager }).reservations = reservations;

		try {
			await withReservation(entity, "push", async (context, reservation) => {
				(plugin as unknown as { reservations: ReservationManager }).reservations = reservation.manager;
				const result = await plugin.pushConfiguredDatabase(entry, entity.vaultFolder, {
					context,
					retryRowIds: [filePath],
					onPushIntentCreating: async () => "manual-merge-test-intent",
					onPushIntentCreated: async () => undefined,
					onPushIntentCommitted: async () => undefined,
				});
				expect(result.failed).toBe(0);
				expect(result.created).toBe(1);
			});
			expect(conflictResolver).not.toHaveBeenCalled();
			const matches = await waitForVerifyPages(entity, syntheticId, 1);
			expect(matches).toHaveLength(1);
			pushedPageId = matches[0].id;
			createdPages.push({ entity, pageId: pushedPageId });
			const afterPush = await readVaultFile(filePath);
			const { props } = parseFrontmatter(afterPush);
			expect(props["notion-id"]).toBe(pushedPageId);
			expect(props["notion-url"], "manual_merge create backfill should include notion-url").toEqual(expect.any(String));
			expect(props["notion-last-edited"], "manual_merge create backfill should include notion-last-edited").toEqual(expect.any(String));
		} finally {
			createClient.mockRestore();
			const pages = pushedPageId
				? [{ id: pushedPageId } as PageObjectResponse]
				: await queryVerifyPages(entity, syntheticId);
			for (const page of pages) await archivePage(page.id);
			await deleteVaultFile(filePath);
			expect(await waitForVerifyPages(entity, syntheticId, 0)).toHaveLength(0);
		}
	}, 120_000);

	it("T5 rejects synthetic ReservationContext at the configured production push boundary before Notion or vault work", async () => {
		const entity = ENTITIES[0];
		const plugin = new NotionFreezePlugin();
		const app = {
			vault: {
				getMarkdownFiles: vi.fn(() => []),
				getAbstractFileByPath: vi.fn(),
				adapter: { write: vi.fn() },
			},
			metadataCache: { getFileCache: vi.fn() },
			workspace: { trigger: vi.fn() },
		};
		const createClient = vi.spyOn(notionClientModule, "createNotionClient");
		plugin.app = app as never;
		plugin.settings = {
			...plugin.settings,
			apiKey: "integration-key-redacted",
			databases: [syncedDatabase(entity)],
		};

		try {
			await expect(plugin.pushConfiguredDatabase(syncedDatabase(entity), entity.vaultFolder, {
				context: { id: "synthetic-context" } as never,
			})).rejects.toThrow("Reservation required before configured database push");
			expect(createClient).not.toHaveBeenCalled();
			expect(app.vault.getMarkdownFiles).not.toHaveBeenCalled();
			expect(app.vault.getAbstractFileByPath).not.toHaveBeenCalled();
			expect(app.vault.adapter.write).not.toHaveBeenCalled();
		} finally {
			createClient.mockRestore();
		}
	});

	it("T6 exercises lockfile claim semantics and restores the live Friction seed", async () => {
		const entity = ENTITIES.find((candidate) => candidate.key === "friction")!;
		const original = await readNextId(entity);
		const helper = path.join(process.cwd(), "tests/integration/_helpers/claim-next-id.py");
		const { stdout } = await execFileAsync("python3", [
			helper,
			path.join(VAULT_ROOT, entity.vaultFolder),
			"--sequential",
			"10",
			"--concurrent",
			"100",
		]);
		const result = JSON.parse(stdout) as {
			sequential: number[];
			concurrent: number[];
			afterClaims: number;
		};
		expect(result.sequential).toEqual(Array.from({ length: 10 }, (_, index) => original + index));
		expect(new Set(result.concurrent)).toHaveLength(100);
		expect(result.concurrent.every((value) => value >= original + 10 && value < original + 110)).toBe(true);
		expect(result.afterClaims).toBe(original + 110);
		expect(await readNextId(entity)).toBe(original);
	});

	it("T7 parses Wovenkeg-style same-line escaped multiline frontmatter without literal blocks or inline empty lists", () => {
		const samples = [
			formatMarkdown({
				ID: "DEC-9461",
				Decision: "Parser fidelity decision",
				Context: "Decision line one.\nDecision line two.",
				Status: "LOCKED",
			}, "# Decision"),
			formatMarkdown({
				ID: "LOOP-9613",
				Loop: "Parser fidelity loop",
				"Next Action": "Loop line one.\nLoop line two.",
				Severity: "🟢 Noted",
				Status: "Open",
			}, "# Loop"),
			formatMarkdown({
				ID: "FRIC-9172",
				Friction: "Parser fidelity friction",
				"What Happened": "Friction happened line one.\nFriction happened line two.",
				"What Should Have Happened": "Friction expected line one.\nFriction expected line two.",
				Resolved: false,
			}, "# Friction"),
		];

		for (const raw of samples) {
			expect(raw).not.toMatch(/:\s*\|\s*$/m);
			assertNoEmptyFrontmatterEmissions(raw);
			const { props } = parseFrontmatter(raw);
			for (const [key, value] of Object.entries(props)) {
				if (typeof value === "string" && key !== "ID") {
					expect(value).not.toBe("|");
				}
			}
		}

		expect(parseFrontmatter(samples[0]).props.Context).toBe("Decision line one.\nDecision line two.");
		expect(parseFrontmatter(samples[1]).props["Next Action"]).toBe("Loop line one.\nLoop line two.");
		expect(parseFrontmatter(samples[2]).props["What Happened"]).toBe("Friction happened line one.\nFriction happened line two.");
		expect(parseFrontmatter(samples[2]).props["What Should Have Happened"]).toBe("Friction expected line one.\nFriction expected line two.");
	});
});

async function initClient(): Promise<Client> {
	if (!clientPromise) {
		clientPromise = readIntegrationNotionApiKey().then((apiKey) =>
			createNotionClient(apiKey, { fetch: fetch.bind(globalThis) as never })
		);
	}
	return clientPromise;
}

async function queryVerifyPages(entity: EntityConfig, contains?: string): Promise<PageObjectResponse[]> {
	const client = await initClient();
	const filters: unknown[] = [
		{ property: entity.titleProperty, title: { starts_with: VERIFY_TITLE_ROOT } },
	];
	if (contains) {
		filters.push({ property: entity.titleProperty, title: { contains } });
	}
	const pages: PageObjectResponse[] = [];
	let cursor: string | undefined;
	do {
		const response = await notionRequest(() => client.dataSources.query({
			data_source_id: entity.dataSourceId,
			filter: filters.length === 1 ? filters[0] : { and: filters },
			start_cursor: cursor,
			page_size: 100,
		} as never));
		for (const result of response.results) {
			if (result.object === "page" && "properties" in result) pages.push(result as PageObjectResponse);
		}
		cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
	} while (cursor);
	return pages;
}

async function waitForVerifyPages(entity: EntityConfig, contains: string, count: number): Promise<PageObjectResponse[]> {
	let latest: PageObjectResponse[] = [];
	for (let attempt = 0; attempt < 8; attempt++) {
		latest = await queryVerifyPages(entity, contains);
		if (latest.length === count) return latest;
		await new Promise((resolve) => setTimeout(resolve, 750));
	}
	return latest;
}

async function createPage(entity: EntityConfig, title: string): Promise<PageObjectResponse> {
	const client = await initClient();
	const page = await notionRequest(() => client.pages.create({
		parent: { data_source_id: entity.dataSourceId },
		properties: entity.pullProperties(title),
	} as never));
	if (page.object !== "page" || !("properties" in page)) {
		throw new Error(`Expected created ${entity.entityName} object to be a full page response.`);
	}
	createdPages.push({ entity, pageId: page.id });
	return page as PageObjectResponse;
}

async function archivePage(pageId: string): Promise<void> {
	const client = await initClient();
	await notionRequest(() => client.pages.update({ page_id: pageId, archived: true } as never));
	const index = createdPages.findIndex((entry) => entry.pageId === pageId);
	if (index >= 0) createdPages.splice(index, 1);
}

async function cleanupTrackedArtifacts(): Promise<void> {
	const pages = [...createdPages];
	for (const { pageId } of pages) {
		await archivePage(pageId).catch((err) => {
			console.warn(`Stonerelay integration cleanup warning: failed to archive page ${pageId}: ${err instanceof Error ? err.message : String(err)}`);
		});
	}
	for (const filePath of [...createdFiles]) {
		await deleteVaultFile(filePath).catch((err) => {
			console.warn(`Stonerelay integration cleanup warning: failed to delete ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
		});
	}
}

async function sweepAll(label: string): Promise<void> {
	for (const entity of ENTITIES) {
		const pages = await queryVerifyPages(entity);
		for (const page of pages) {
			console.warn(`Stonerelay integration ${label} cleanup archived ${entity.entityName} test page ${page.id}.`);
			await archivePage(page.id);
		}
		const remaining = await queryVerifyPages(entity);
		expect(remaining, `${label} Notion cleanup for ${entity.entityName}`).toHaveLength(0);

		const files = await findVaultFiles(entity, VERIFY_TITLE_ROOT);
		for (const filePath of files) {
			console.warn(`Stonerelay integration ${label} cleanup deleted vault test file ${filePath}.`);
			await deleteVaultFile(filePath);
		}
		expect(await findVaultFiles(entity, VERIFY_TITLE_ROOT), `${label} vault cleanup for ${entity.entityName}`).toHaveLength(0);
	}
}

async function assertLockfileSeeds(): Promise<void> {
	for (const entity of ENTITIES) {
		const value = await readNextId(entity);
		expect(value, `${entity.uniqueIdPrefix} .next-id ${BOOTSTRAP_DIAGNOSTIC}`).toBeGreaterThanOrEqual(entity.expectedSeed);
		const lock = await stat(path.join(VAULT_ROOT, entity.vaultFolder, ".next-id.lock"));
		expect(lock.size, `${entity.uniqueIdPrefix} .next-id.lock inode target must be empty`).toBe(0);
	}
}

async function readNextId(entity: EntityConfig): Promise<number> {
	const raw = (await readFile(path.join(VAULT_ROOT, entity.vaultFolder, ".next-id"), "utf8")).trim();
	if (!/^\d+$/.test(raw)) throw new Error(`${entity.vaultFolder}/.next-id is not an integer. ${BOOTSTRAP_DIAGNOSTIC}`);
	const value = Number(raw);
	if (value < entity.expectedSeed) throw new Error(`${entity.vaultFolder}/.next-id was ${value}. ${BOOTSTRAP_DIAGNOSTIC}`);
	return value;
}

async function withReservation<T>(
	entity: EntityConfig,
	type: "push" | "pull",
	task: (context: Awaited<ReturnType<ReservationManager["acquire"]>>["context"], reservation: { manager: ReservationManager }) => Promise<T>
): Promise<T> {
	const manager = new ReservationManager();
	const reservation = await manager.acquire({
		entryId: `integration:${entity.key}:${type}:${Date.now()}`,
		entryName: `${entity.entityName} integration ${type}`,
		databaseId: entity.databaseId,
		vaultFolder: entity.vaultFolder,
		type,
		policy: "manual",
	});
	try {
		return await task(reservation.context, { manager });
	} finally {
		reservation.release();
	}
}

function fileBackedApp(visibleFilePaths: string[]) {
	const baseWrites = new Map<string, string>();
	const adapter = {
		async write(relativePath: string, data: string) {
			if (relativePath.endsWith(".base") || relativePath.includes(".base.tmp-")) {
				baseWrites.set(relativePath, data);
				return;
			}
			const absolutePath = path.join(VAULT_ROOT, relativePath);
			await mkdir(path.dirname(absolutePath), { recursive: true });
			await writeFile(absolutePath, data, "utf8");
		},
		async read(relativePath: string) {
			if (baseWrites.has(relativePath)) return baseWrites.get(relativePath) ?? "";
			return readVaultFile(relativePath);
		},
		async rename(from: string, to: string) {
			if (from.endsWith(".base") || from.includes(".base.tmp-") || to.endsWith(".base")) {
				const data = baseWrites.get(from) ?? "";
				baseWrites.set(to, data);
				baseWrites.delete(from);
				return;
			}
			await mkdir(path.dirname(path.join(VAULT_ROOT, to)), { recursive: true });
			await rm(path.join(VAULT_ROOT, to), { force: true });
			await import("node:fs/promises").then((fs) => fs.rename(path.join(VAULT_ROOT, from), path.join(VAULT_ROOT, to)));
		},
		async remove(relativePath: string) {
			baseWrites.delete(relativePath);
			await rm(path.join(VAULT_ROOT, relativePath), { force: true });
		},
	};

	return {
		vault: {
			adapter,
			getAbstractFileByPath(relativePath: string) {
				const normalized = normalizePath(relativePath);
				const entityFolder = ENTITIES.find((entity) => normalizePath(entity.vaultFolder) === normalized);
				if (entityFolder) return folder(normalized);
				if (normalized.endsWith(".base")) return null;
				const absolutePath = path.join(VAULT_ROOT, normalized);
				if (visibleFilePaths.map(normalizePath).includes(normalized)) return file(normalized);
				try {
					accessSync(absolutePath);
					return file(normalized);
				} catch {
					return null;
				}
			},
			getMarkdownFiles() {
				return visibleFilePaths.map((entry) => file(normalizePath(entry)));
			},
			async cachedRead(tfile: TFile) {
				return readVaultFile(tfile.path);
			},
			async read(tfile: TFile) {
				return readVaultFile(tfile.path);
			},
			async createFolder(relativePath: string) {
				await mkdir(path.join(VAULT_ROOT, relativePath), { recursive: true });
			},
		},
		metadataCache: {
			getFileCache(tfile: TFile) {
				try {
					const raw = readFileSync(path.join(VAULT_ROOT, tfile.path), "utf8");
					return { frontmatter: parseFrontmatter(raw).props };
				} catch {
					return { frontmatter: {} };
				}
			},
		},
		workspace: { trigger: vi.fn() },
	};
}

function file(relativePath: string): TFile {
	const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
	return Object.assign(Object.create(TFile.prototype), {
		path: relativePath,
		name,
		basename: name.replace(/\.md$/, ""),
		extension: name.endsWith(".md") ? "md" : "",
		stat: { mtime: Date.now() },
		parent: folder(relativePath.slice(0, relativePath.lastIndexOf("/"))),
	});
}

function folder(relativePath: string): TFolder {
	return Object.assign(Object.create(TFolder.prototype), {
		path: relativePath,
		children: [],
	});
}

async function writeVaultFile(relativePath: string, content: string): Promise<void> {
	const absolutePath = path.join(VAULT_ROOT, relativePath);
	await mkdir(path.dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, content, "utf8");
	createdFiles.add(relativePath);
}

async function readVaultFile(relativePath: string): Promise<string> {
	return readFile(path.join(VAULT_ROOT, relativePath), "utf8");
}

async function deleteVaultFile(relativePath: string): Promise<void> {
	await rm(path.join(VAULT_ROOT, relativePath), { force: true });
	createdFiles.delete(relativePath);
}

async function findVaultFiles(entity: EntityConfig, needle: string): Promise<string[]> {
	const absoluteFolder = path.join(VAULT_ROOT, entity.vaultFolder);
	const entries = await readdir(absoluteFolder, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile() && entry.name.includes(needle))
		.map((entry) => path.join(entity.vaultFolder, entry.name));
}

function assertPageProperties(page: PageObjectResponse, expected: Record<string, FrontmatterValue>): void {
	for (const [key, value] of Object.entries(expected)) {
		const property = page.properties[key];
		expect(propertyValue(property), `Notion property ${key}`).toBe(value);
	}
}

function assertNoEmptyFrontmatterEmissions(raw: string): void {
	const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? raw;
	expect(frontmatter).not.toMatch(/:\s*\[\]\s*$/m);
	expect(frontmatter).not.toMatch(/:\s*\{\}\s*$/m);
	expect(frontmatter).not.toMatch(/:\s*null\s*$/m);
	expect(frontmatter).not.toMatch(/:\s*""\s*$/m);
	expect(frontmatter).not.toMatch(/:\s*''\s*$/m);
}

function propertyValue(property: PageObjectResponse["properties"][string] | undefined): FrontmatterValue | string[] | undefined {
	if (!property) return undefined;
	switch (property.type) {
		case "title":
			return plainText(property.title);
		case "rich_text":
			return plainText(property.rich_text);
		case "select":
			return property.select?.name ?? null;
		case "status":
			return property.status?.name ?? null;
		case "date":
			return property.date?.start ?? null;
		case "checkbox":
			return property.checkbox;
		case "multi_select":
			return property.multi_select.map((item) => item.name);
		default:
			return undefined;
	}
}

function plainText(items: Array<{ plain_text?: string }>): string {
	return items.map((item) => item.plain_text ?? "").join("");
}

function formatMarkdown(frontmatter: Record<string, FrontmatterValue>, body: string): string {
	const lines = ["---"];
	for (const [key, value] of Object.entries(frontmatter)) {
		lines.push(`${formatKey(key)}: ${formatValue(value)}`);
	}
	lines.push("---", body);
	return `${lines.join("\n")}\n`;
}

function formatKey(key: string): string {
	return key.includes(" ") || key.includes("(") || key.includes(")") ? `"${key.replace(/"/g, '\\"')}"` : key;
}

function formatValue(value: FrontmatterValue): string {
	if (value === null) return "null";
	if (typeof value === "boolean") return String(value);
	if (typeof value === "number") return String(value);
	const needsQuote =
		value.includes("\n") ||
		value.includes(":") ||
		value.includes("#") ||
		value.includes('"') ||
		value.startsWith("[") ||
		value.startsWith("{") ||
		value.startsWith("-") ||
		value.startsWith(" ") ||
		/^\d+$/.test(value);
	return needsQuote ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"` : value;
}

function verifyPrefix(): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return `${VERIFY_TITLE_ROOT}${stamp}-${process.hrtime.bigint()}]`;
}

function safeFileName(value: string): string {
	return value.replace(/[\\/:*?"<>|]/g, "-").trim();
}

function normalizePath(value: string): string {
	return value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function titleProp(value: string): Record<string, unknown> {
	return { title: [{ type: "text", text: { content: value } }] };
}

function richTextProp(value: string): Record<string, unknown> {
	return { rich_text: [{ type: "text", text: { content: value } }] };
}

function selectProp(value: string): Record<string, unknown> {
	return { select: { name: value } };
}

function dateProp(value: string): Record<string, unknown> {
	return { date: { start: value } };
}

function checkboxProp(value: boolean): Record<string, unknown> {
	return { checkbox: value };
}

function syncedDatabase(entity: EntityConfig): SyncedDatabase {
	return {
		id: `integration-${entity.key}`,
		name: entity.entityName,
		databaseId: entity.databaseId,
		outputFolder: "3. System/",
		errorLogFolder: "",
		groupId: null,
		autoSync: "inherit",
		direction: "bidirectional",
		enabled: true,
		lastSyncedAt: null,
		lastSyncStatus: "never",
		lastPulledAt: null,
		lastPushedAt: null,
		current_phase: "phase_1",
		initial_seed_direction: "pull",
		source_of_truth: "manual_merge",
		first_sync_completed_at: null,
		nest_under_db_name: true,
		templater_managed: false,
		current_sync_id: null,
		lastCommittedRowId: null,
		lastSyncErrors: [],
	};
}
