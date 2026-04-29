import { describe, expect, it } from "vitest";
import { USER_ACTION_AUDIT } from "../src/action-audit";
import {
	evaluatePullSafety,
	evaluatePushSafety,
	evaluateStaleNotionIdSafety,
	confirmStaleNotionIdSafety,
	retryDirectionForErrors,
	validatePushCandidateFiles,
	validatePullCandidateFiles,
} from "../src/sync-safety";
import { NotionFreezeSettings, SyncError, SyncedDatabase } from "../src/types";

const bugsDbId = "21b39452dc7b4a159d6b7b229c21cc80";
const sessionsDbId = "11111111111141118111111111111111";

function database(overrides: Partial<SyncedDatabase> = {}): SyncedDatabase {
	return {
		id: overrides.id ?? "bugs",
		name: overrides.name ?? "Bugs DB",
		databaseId: overrides.databaseId ?? bugsDbId,
		outputFolder: overrides.outputFolder ?? "3. System/",
		errorLogFolder: overrides.errorLogFolder ?? "",
		groupId: overrides.groupId ?? null,
		autoSync: overrides.autoSync ?? "inherit",
		direction: overrides.direction ?? "bidirectional",
		enabled: overrides.enabled ?? true,
		lastSyncedAt: overrides.lastSyncedAt ?? "2026-04-27T10:00:00.000Z",
		lastSyncStatus: overrides.lastSyncStatus ?? "ok",
		lastSyncError: overrides.lastSyncError,
		lastPulledAt: overrides.lastPulledAt ?? null,
		lastPushedAt: overrides.lastPushedAt ?? null,
		current_phase: overrides.current_phase ?? "phase_2",
		initial_seed_direction: overrides.initial_seed_direction ?? "pull",
		source_of_truth: overrides.source_of_truth ?? "notion",
		first_sync_completed_at: overrides.first_sync_completed_at ?? "2026-04-27T10:00:00.000Z",
		nest_under_db_name: overrides.nest_under_db_name ?? true,
		templater_managed: overrides.templater_managed ?? false,
		current_sync_id: overrides.current_sync_id ?? null,
		lastCommittedRowId: overrides.lastCommittedRowId ?? null,
		lastSyncErrors: overrides.lastSyncErrors ?? [],
	};
}

function settings(databases: SyncedDatabase[]): NotionFreezeSettings {
	return {
		apiKey: "",
		defaultOutputFolder: "_relay",
		defaultErrorLogFolder: "",
		databases,
		pages: [],
		groups: [],
		pendingConflicts: [],
		autoSyncEnabled: false,
		autoSyncDatabasesByDefault: false,
		autoSyncPagesByDefault: false,
		schemaVersion: 6,
	};
}

describe("sync safety gates", () => {
	it("keeps the §6 user-action audit complete", () => {
			expect(USER_ACTION_AUDIT).toHaveLength(38);
		expect(USER_ACTION_AUDIT.every((row) => row.pathHelper && row.safetyGate)).toBe(true);
		expect(USER_ACTION_AUDIT.map((row) => row.action)).toContain("Apply conflict resolution: Keep Vault");
	});

	it("hard-blocks shared resolved content folders for manual Push and Push All through the same helper", () => {
		const bugs = database({ id: "bugs", name: "Bugs DB", outputFolder: "3. System", nest_under_db_name: false });
		const sessions = database({ id: "sessions", name: "Sessions DB", databaseId: sessionsDbId, outputFolder: "3. System", nest_under_db_name: false });
		const data = settings([bugs, sessions]);

		const manual = evaluatePushSafety({ settings: data, entry: bugs, folderExists: true, allowDisabledEntry: true });
		const pushAll = evaluatePushSafety({ settings: data, entry: bugs, folderExists: true, allowDisabledEntry: false });

		expect(manual.hardBlocks.map((issue) => issue.code)).toContain("shared_resolved_content_folder");
		expect(pushAll.hardBlocks.map((issue) => issue.code)).toContain("shared_resolved_content_folder");
	});

	it("hard-blocks ancestor and descendant content folder overlap", () => {
		const broad = database({ id: "broad", name: "Broad DB", outputFolder: "3. System", nest_under_db_name: false });
		const nested = database({ id: "nested", name: "Nested DB", databaseId: sessionsDbId, outputFolder: "3. System", nest_under_db_name: true });
		const decision = evaluatePushSafety({ settings: settings([broad, nested]), entry: broad, folderExists: true, allowDisabledEntry: true });

		expect(decision.hardBlocks.map((issue) => issue.code)).toContain("overlapping_content_folder");
	});

	it("hard-blocks pull when resolved folders overlap before Notion query", () => {
		const broad = database({ id: "broad", name: "Broad DB", outputFolder: "3. System", nest_under_db_name: false });
		const nested = database({ id: "nested", name: "Nested DB", databaseId: sessionsDbId, outputFolder: "3. System", nest_under_db_name: true });
		const decision = evaluatePullSafety({ settings: settings([broad, nested]), entry: broad });

		expect(decision.hardBlocks.map((issue) => issue.code)).toContain("overlapping_content_folder");
		expect(decision.hardBlocks[0].message).toContain("Pull blocked");
	});

	it("hard-blocks pull when two configured entries point at the same Notion database id", () => {
		const first = database({ id: "first", name: "First DB" });
		const second = database({ id: "second", name: "Second DB", outputFolder: "Other" });
		const issues = validatePullCandidateFiles(settings([first, second]), first);

		expect(issues.map((issue) => issue.code)).toContain("same_database_collision");
	});

	it("rejects push retries outside the resolved content folder", () => {
		const bugs = database({ id: "bugs", name: "Bugs DB", outputFolder: "3. System/" });
		const decision = evaluatePushSafety({
			settings: settings([bugs]),
			entry: bugs,
			folderExists: true,
			retryRowIds: ["3. System/Sessions DB/SES-381.md"],
			allowDisabledEntry: true,
		});

		expect(decision.hardBlocks.map((issue) => issue.code)).toContain("push_retry_outside_source");
	});

	it("accepts pull retry row IDs without treating them as vault paths", () => {
		const bugs = database();
		const decision = evaluatePullSafety({
			settings: settings([bugs]),
			entry: bugs,
			retryRowIds: ["34f61ec214e681b6b1f9db40159e1d16"],
		});

		expect(decision.allowed).toBe(true);
	});

	it("blocks mixed retry directions before routing", () => {
		const errors: SyncError[] = [
			{ rowId: "row-1", direction: "pull", error: "pull failed", timestamp: "2026-04-27T10:00:00.000Z" },
			{ rowId: "3. System/Bugs DB/Bug.md", direction: "push", error: "push failed", timestamp: "2026-04-27T10:00:01.000Z" },
		];

		expect(retryDirectionForErrors(errors)).toBe("mixed");
	});

	it("lets conflict Keep Vault use push safety with the conflict retry path while still checking the source folder", () => {
		const bugs = database();
		const decision = evaluatePushSafety({
			settings: settings([bugs]),
			entry: bugs,
			folderExists: true,
			retryRowIds: ["3. System/Bugs DB/Bug 57.md"],
			allowDisabledEntry: true,
			allowPendingConflicts: true,
		});

		expect(decision.allowed).toBe(true);
	});

	it("hard-blocks mismatched notion-database-id files inside the push source folder", () => {
		const issues = validatePushCandidateFiles(bugsDbId, [
			{ path: "3. System/Bugs DB/SES-381.md", notionDatabaseId: sessionsDbId },
		]);

		expect(issues).toHaveLength(1);
		expect(issues[0].code).toBe("mismatched_notion_database_id");
	});

	it("hard-blocks duplicate notion-id values before any Notion write", () => {
		const issues = validatePushCandidateFiles(bugsDbId, [
			{ path: "3. System/Bugs DB/one.md", notionId: "abc123" },
			{ path: "3. System/Bugs DB/two.md", notionId: "abc123" },
		]);

		expect(issues.map((issue) => issue.code)).toContain("duplicate_notion_id");
		expect(issues[0].message).toContain("Stonerelay does not pick a winner");
	});

	it("proves the Bugs incident fixture cannot push unrelated sibling database files into Bugs", () => {
		const bugs = database({ id: "bugs", name: "Bugs DB", databaseId: bugsDbId, outputFolder: "3. System/", nest_under_db_name: true });
		const sessions = database({ id: "sessions", name: "Sessions DB", databaseId: sessionsDbId, outputFolder: "3. System/", nest_under_db_name: true });
		const data = settings([bugs, sessions]);
		const decision = evaluatePushSafety({
			settings: data,
			entry: bugs,
			folderExists: true,
			candidateFiles: [
				{ path: "3. System/Bugs DB/BUG-57.md", notionDatabaseId: bugsDbId },
			],
			allowDisabledEntry: true,
		});

		expect(decision.allowed).toBe(true);
		expect(decision.pathModel.pushSourceFolder).toBe("3. System/Bugs DB");
		expect(decision.pathModel.pushSourceFolder).not.toBe("3. System");
		expect(decision.pathModel.pushSourceFolder).not.toBe("3. System/Sessions DB");
	});

	it("keeps stale notion-id protective skips below the escalation threshold", () => {
		const files = Array.from({ length: 100 }, (_, index) => ({
			path: `3. System/Bugs DB/${index}.md`,
			staleNotionId: index < 5,
		}));

		expect(evaluateStaleNotionIdSafety(files)).toMatchObject({
			kind: "ok",
			skipCount: 5,
			skipRatio: 0.05,
		});
	});

	it("requires confirmation above the stale notion-id count threshold", () => {
		const files = Array.from({ length: 100 }, (_, index) => ({
			path: `3. System/Bugs DB/${index}.md`,
			staleNotionId: index < 15,
		}));

		expect(evaluateStaleNotionIdSafety(files)).toMatchObject({
			kind: "requires-stale-id-confirmation",
			skipCount: 15,
		});
	});

	it("requires confirmation above the stale notion-id ratio threshold", () => {
		const files = Array.from({ length: 10 }, (_, index) => ({
			path: `3. System/Bugs DB/${index}.md`,
			staleNotionId: index < 5,
		}));

		expect(evaluateStaleNotionIdSafety(files)).toMatchObject({
			kind: "requires-stale-id-confirmation",
			skipCount: 5,
			skipRatio: 0.5,
		});
	});

	it("lets operator confirmation proceed with stale notion-id skips visible", async () => {
		const state = evaluateStaleNotionIdSafety([
			{ path: "3. System/Bugs DB/1.md", staleNotionId: true },
			{ path: "3. System/Bugs DB/2.md", staleNotionId: true },
			{ path: "3. System/Bugs DB/3.md", staleNotionId: true },
			{ path: "3. System/Bugs DB/4.md", staleNotionId: true },
			{ path: "3. System/Bugs DB/5.md", staleNotionId: true },
			{ path: "3. System/Bugs DB/6.md", staleNotionId: false },
			{ path: "3. System/Bugs DB/7.md", staleNotionId: false },
			{ path: "3. System/Bugs DB/8.md", staleNotionId: false },
			{ path: "3. System/Bugs DB/9.md", staleNotionId: false },
			{ path: "3. System/Bugs DB/10.md", staleNotionId: false },
		]);

		const confirmed = await confirmStaleNotionIdSafety(state, async (message) => {
			expect(message).toContain("5 files (50%)");
			return true;
		});

		expect(confirmed).toBe(true);
	});

	it("aborts cleanly when stale notion-id confirmation is cancelled", async () => {
		const state = evaluateStaleNotionIdSafety(Array.from({ length: 10 }, (_, index) => ({
			path: `3. System/Bugs DB/${index}.md`,
			staleNotionId: index < 5,
		})));

		await expect(confirmStaleNotionIdSafety(state, async () => false)).resolves.toBe(false);
	});
});
