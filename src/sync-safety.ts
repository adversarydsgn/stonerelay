import { normalizeNotionId } from "./notion-client";
import {
	normalizeForCompare,
	pathStartsWith,
	pathsOverlap,
	resolveDatabasePathModel,
	validateVaultFolderPath,
} from "./path-model";
import { Conflict, NotionFreezeSettings, SyncError, SyncedDatabase } from "./types";

export type SafetySeverity = "blocker" | "warning";

export const STALE_NOTION_ID_SKIP_COUNT_THRESHOLD = 10;
export const STALE_NOTION_ID_SKIP_RATIO_THRESHOLD = 0.25;

export interface SafetyIssue {
	code: string;
	message: string;
	severity: SafetySeverity;
	path?: string;
}

export interface CandidatePushFile {
	path: string;
	notionDatabaseId?: unknown;
	notionId?: unknown;
	staleNotionId?: boolean;
}

export interface CandidatePullFile extends CandidatePushFile {
	legacy?: boolean;
}

export interface PushSafetyInput {
	settings: NotionFreezeSettings;
	entry: SyncedDatabase;
	discoveredContentFolder?: string | null;
	folderExists?: boolean;
	retryRowIds?: string[];
	candidateFiles?: CandidatePushFile[];
	allowDisabledEntry?: boolean;
	allowPendingConflicts?: boolean;
	conflicts?: Conflict[];
}

export interface PullSafetyInput {
	settings: NotionFreezeSettings;
	entry: SyncedDatabase;
	discoveredContentFolder?: string | null;
	retryRowIds?: string[];
	candidateFiles?: CandidatePullFile[];
}

export interface SafetyDecision {
	allowed: boolean;
	hardBlocks: SafetyIssue[];
	warnings: SafetyIssue[];
	pathModel: ReturnType<typeof resolveDatabasePathModel>;
}

export type StaleNotionIdSafetyState =
	| { kind: "ok"; skipCount: number; skipRatio: number; threshold: StaleNotionIdThreshold }
	| { kind: "requires-stale-id-confirmation"; skipCount: number; skipRatio: number; threshold: StaleNotionIdThreshold };

export interface StaleNotionIdThreshold {
	count: number;
	ratio: number;
}

export function evaluatePushSafety(input: PushSafetyInput): SafetyDecision {
	const pathModel = resolveDatabasePathModel(input.settings, input.entry, {
		discoveredContentFolder: input.discoveredContentFolder,
	});
	const hardBlocks: SafetyIssue[] = [];
	const warnings: SafetyIssue[] = [];
	const parentValidation = validateVaultFolderPath(pathModel.configuredParentFolder);
	const sourceValidation = validateVaultFolderPath(pathModel.pushSourceFolder);
	const errorLogValidation = pathModel.errorLogFolder ? validateVaultFolderPath(pathModel.errorLogFolder) : null;

	if (!parentValidation.ok) {
		hardBlocks.push(issue("invalid_parent_folder", parentValidation.error ?? "Configured parent folder is invalid.", pathModel.configuredParentFolder));
	}
	if (!sourceValidation.ok) {
		hardBlocks.push(issue("invalid_push_source_folder", sourceValidation.error ?? "Push source folder is invalid.", pathModel.pushSourceFolder));
	}
	if (errorLogValidation && !errorLogValidation.ok) {
		hardBlocks.push(issue("invalid_error_log_folder", errorLogValidation.error ?? "Error log folder is invalid.", pathModel.errorLogFolder ?? undefined));
	}
	if (input.folderExists === false) {
		hardBlocks.push(issue("missing_push_source_folder", `Push source folder not found: ${pathModel.pushSourceFolder}`, pathModel.pushSourceFolder));
	}
	if (!input.entry.enabled && !input.allowDisabledEntry) {
		hardBlocks.push(issue("disabled_entry", `${input.entry.name} is disabled. Enable it before Push All can write to Notion.`));
	}

	const conflicts = input.conflicts ?? input.settings.pendingConflicts;
	if (!input.allowPendingConflicts && conflicts.some((conflict) => !conflict.entryId || conflict.entryId === input.entry.id)) {
		hardBlocks.push(issue("pending_conflicts", `${input.entry.name} has pending conflicts. Resolve them before pushing.`));
	}

	hardBlocks.push(...overlapIssues(input.settings, input.entry, pathModel.pushSourceFolder, "push"));

	for (const retryId of input.retryRowIds ?? []) {
		if (!pathStartsWith(retryId, pathModel.pushSourceFolder)) {
			hardBlocks.push(issue("push_retry_outside_source", `Push retry path is outside "${pathModel.pushSourceFolder}": ${retryId}`, retryId));
		}
	}

	const mismatch = mismatchedDatabaseFiles(input.entry.databaseId, input.candidateFiles ?? []);
	if (mismatch.length > 0) {
		const first = mismatch[0];
		hardBlocks.push(issue(
			"mismatched_notion_database_id",
			`Push blocked for ${input.entry.name}: ${mismatch.length} file${mismatch.length === 1 ? "" : "s"} in "${pathModel.pushSourceFolder}" belong to another Notion database. First mismatch: ${first.path}.`,
			first.path
		));
	}

	for (const stale of staleNotionIdWarnings(input.candidateFiles ?? [])) {
		warnings.push(stale);
	}

	return {
		allowed: hardBlocks.length === 0,
		hardBlocks,
		warnings,
		pathModel,
	};
}

export function evaluatePullSafety(input: PullSafetyInput): SafetyDecision {
	const pathModel = resolveDatabasePathModel(input.settings, input.entry, {
		discoveredContentFolder: input.discoveredContentFolder,
	});
	const hardBlocks: SafetyIssue[] = [];
	const warnings: SafetyIssue[] = [];
	const parentValidation = validateVaultFolderPath(pathModel.configuredParentFolder);
	const targetValidation = validateVaultFolderPath(pathModel.pullTargetFolder);
	const errorLogValidation = pathModel.errorLogFolder ? validateVaultFolderPath(pathModel.errorLogFolder) : null;

	if (!parentValidation.ok) {
		hardBlocks.push(issue("invalid_parent_folder", parentValidation.error ?? "Configured parent folder is invalid.", pathModel.configuredParentFolder));
	}
	if (!targetValidation.ok) {
		hardBlocks.push(issue("invalid_pull_target_folder", targetValidation.error ?? "Pull target folder is invalid.", pathModel.pullTargetFolder));
	}
	if (errorLogValidation && !errorLogValidation.ok) {
		hardBlocks.push(issue("invalid_error_log_folder", errorLogValidation.error ?? "Error log folder is invalid.", pathModel.errorLogFolder ?? undefined));
	}
	for (const retryId of input.retryRowIds ?? []) {
		if (looksLikeVaultPath(retryId)) {
			hardBlocks.push(issue("pull_retry_is_vault_path", `Pull retry expects Notion row IDs, not vault file paths: ${retryId}`, retryId));
		}
	}
	hardBlocks.push(...overlapIssues(input.settings, input.entry, pathModel.pullTargetFolder, "pull"));
	hardBlocks.push(...sameDatabaseIssues(input.settings, input.entry));
	for (const file of input.candidateFiles ?? []) {
		if (file.legacy) {
			warnings.push(issue("legacy_missing_notion_database_id", `Legacy file lacks notion-database-id and may be backfilled during Pull: ${file.path}`, file.path, "warning"));
		}
	}

	return {
		allowed: hardBlocks.length === 0,
		hardBlocks,
		warnings,
		pathModel,
	};
}

export function pushReadinessSummary(decision: SafetyDecision): string {
	if (decision.hardBlocks.length > 0) return `Blocked: ${decision.hardBlocks[0].message}`;
	if (decision.warnings.length > 0) return `Warning: ${decision.warnings[0].message}`;
	return `Ready: Push scans ${decision.pathModel.pushSourceFolder}`;
}

export function retryDirectionForErrors(errors: Pick<SyncError, "direction">[]): "pull" | "push" | "mixed" | "none" {
	if (errors.length === 0) return "none";
	const directions = new Set(errors.map((error) => error.direction));
	if (directions.size > 1) return "mixed";
	return errors[0].direction;
}

export function validatePushCandidateFiles(databaseId: string, files: CandidatePushFile[]): SafetyIssue[] {
	const issues = mismatchedDatabaseFiles(databaseId, files).map((file) => issue(
		"mismatched_notion_database_id",
		`File belongs to another Notion database: ${file.path}`,
		file.path
	));
	issues.push(...duplicateNotionIdIssues(files));
	return issues;
}

export function validatePullCandidateFiles(settings: NotionFreezeSettings, entry: SyncedDatabase, files: CandidatePullFile[] = []): SafetyIssue[] {
	const decision = evaluatePullSafety({ settings, entry, candidateFiles: files });
	return [...decision.hardBlocks, ...decision.warnings];
}

export function evaluateStaleNotionIdSafety(
	files: CandidatePushFile[],
	candidateCount = files.length
): StaleNotionIdSafetyState {
	const skipCount = files.filter((file) => file.staleNotionId).length;
	const skipRatio = candidateCount > 0 ? skipCount / candidateCount : 0;
	const threshold = {
		count: STALE_NOTION_ID_SKIP_COUNT_THRESHOLD,
		ratio: STALE_NOTION_ID_SKIP_RATIO_THRESHOLD,
	};
	if (
		skipCount > STALE_NOTION_ID_SKIP_COUNT_THRESHOLD ||
		skipRatio > STALE_NOTION_ID_SKIP_RATIO_THRESHOLD
	) {
		return { kind: "requires-stale-id-confirmation", skipCount, skipRatio, threshold };
	}
	return { kind: "ok", skipCount, skipRatio, threshold };
}

export function staleNotionIdConfirmationMessage(
	state: Extract<StaleNotionIdSafetyState, { kind: "requires-stale-id-confirmation" }>
): string {
	return `Stonerelay detected ${state.skipCount} files (${Math.round(state.skipRatio * 100)}%) with stale notion-id values that no longer exist in the target Notion database. This may indicate a recreated database or systemic ID drift.`;
}

export async function confirmStaleNotionIdSafety(
	state: StaleNotionIdSafetyState,
	confirm: (message: string) => Promise<boolean>
): Promise<boolean> {
	if (state.kind !== "requires-stale-id-confirmation") return true;
	return confirm(staleNotionIdConfirmationMessage(state));
}

function mismatchedDatabaseFiles(databaseId: string, files: CandidatePushFile[]): CandidatePushFile[] {
	if (!files.some((file) => file.notionDatabaseId !== undefined && file.notionDatabaseId !== null && String(file.notionDatabaseId).trim())) {
		return [];
	}
	let targetId: string;
	try {
		targetId = normalizeNotionId(databaseId);
	} catch {
		return [];
	}
	return files.filter((file) => {
		if (file.notionDatabaseId === undefined || file.notionDatabaseId === null) return false;
		const notionDatabaseId = String(file.notionDatabaseId).trim();
		if (!notionDatabaseId) return false;
		try {
			return normalizeNotionId(notionDatabaseId) !== targetId;
		} catch {
			return true;
		}
	});
}

function staleNotionIdWarnings(files: CandidatePushFile[]): SafetyIssue[] {
	return files
		.filter((file) => file.staleNotionId || (typeof file.notionId === "string" && !file.notionId.trim()))
		.map((file) => ({
			code: "stale_notion_id_warning",
			message: `Stale notion-id warning remains visible for ${file.path}.`,
			severity: "warning" as const,
			path: file.path,
		}));
}

export function duplicateNotionIdIssues(files: CandidatePushFile[]): SafetyIssue[] {
	const pathsById = new Map<string, string[]>();
	for (const file of files) {
		if (typeof file.notionId !== "string") continue;
		const id = file.notionId.trim();
		if (!id) continue;
		const key = id.replace(/-/g, "").toLowerCase();
		pathsById.set(key, [...(pathsById.get(key) ?? []), file.path]);
	}
	const duplicates = [...pathsById.entries()].filter(([, paths]) => paths.length > 1);
	if (duplicates.length === 0) return [];
	return [issue(
		"duplicate_notion_id",
		[
			"Push blocked: duplicate notion-id values in source folder",
			...duplicates.map(([id, paths]) => `  notion-id ${id}: ${paths.join(", ")}`),
			"Resolve duplicates before retrying. Stonerelay does not pick a winner automatically.",
		].join("\n"),
		duplicates[0][1][0]
	)];
}

function overlapIssues(
	settings: NotionFreezeSettings,
	entry: SyncedDatabase,
	folder: string,
	mode: "push" | "pull"
): SafetyIssue[] {
	const issues: SafetyIssue[] = [];
	for (const candidate of settings.databases) {
		if (candidate.id === entry.id) continue;
		const candidateModel = resolveDatabasePathModel(settings, candidate);
		const otherFolder = mode === "push" ? candidateModel.pushSourceFolder : candidateModel.pullTargetFolder;
		if (normalizeForCompare(otherFolder) === normalizeForCompare(folder)) {
			issues.push(issue(
				"shared_resolved_content_folder",
				mode === "push"
					? `Push source folder "${folder}" is a shared resolved content folder with ${candidate.name}. Use database-specific folders before writing to Notion.`
					: `Pull blocked: vault folder "${folder}" overlaps with database "${candidate.name}" (configured at "${otherFolder}").`,
				folder
			));
			continue;
		}
		if (pathsOverlap(otherFolder, folder)) {
			issues.push(issue(
				"overlapping_content_folder",
				mode === "push"
					? `Push source folder "${folder}" overlaps ${candidate.name} at "${otherFolder}". Push would risk scanning unrelated database files.`
					: `Pull blocked: vault folder "${folder}" overlaps with database "${candidate.name}" (configured at "${otherFolder}").`,
				folder
			));
		}
	}
	return issues;
}

function sameDatabaseIssues(settings: NotionFreezeSettings, entry: SyncedDatabase): SafetyIssue[] {
	let target: string;
	try {
		target = normalizeNotionId(entry.databaseId);
	} catch {
		return [];
	}
	const duplicate = settings.databases.find((candidate) => {
		if (candidate.id === entry.id) return false;
		try {
			return normalizeNotionId(candidate.databaseId) === target;
		} catch {
			return false;
		}
	});
	return duplicate
		? [issue("same_database_collision", `Pull blocked: ${entry.name} shares Notion database id with ${duplicate.name}.`)]
		: [];
}

function looksLikeVaultPath(value: string): boolean {
	return value.includes("/") || value.includes("\\") || value.endsWith(".md");
}

function issue(code: string, message: string, path?: string, severity: SafetySeverity = "blocker"): SafetyIssue {
	return { code, message, severity, path };
}
