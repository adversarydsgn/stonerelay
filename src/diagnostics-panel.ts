import { NotionFreezeSettings, SyncError, SyncedDatabase } from "./types";
import { evaluatePullSafety, evaluatePushSafety } from "./sync-safety";
import { ActiveReservationSnapshot } from "./reservations";
import { PushIntentRecovery } from "./push-intents";
import { VaultCanonicalDiagnosticsRow } from "./vault-canonical";

export type DiagnosticsReadiness = "PASS" | "WARNING" | "BLOCKED";

export interface DatabaseDiagnosticsRow {
	entryId: string;
	name: string;
	pushSourceFolder: string;
	pullTargetFolder: string;
	pushReadiness: DiagnosticsReadiness;
	pushReason: string;
	pullReadiness: DiagnosticsReadiness;
	pullReason: string;
	lastPushedAt: string | null;
	lastPulledAt: string | null;
	conflictCount: number;
	duplicateNotionIdCount: number;
	staleIdCandidateCount: number;
	staleIdThresholdWarn: boolean;
	backfilledFileCount: number;
	validationIssues: ValidationDiagnosticsIssue[];
}

export interface DiagnosticsOptions {
	folderExists?: (entry: SyncedDatabase, folder: string) => boolean | undefined;
	staleIdCandidateCount?: (entry: SyncedDatabase, folder: string) => number;
	duplicateNotionIdCount?: (entry: SyncedDatabase) => number;
	backfilledFileCount?: (entry: SyncedDatabase) => number;
	activeOperations?: ActiveReservationSnapshot[];
	pushIntentRecoveries?: PushIntentRecovery[];
	vaultCanonicalRows?: VaultCanonicalDiagnosticsRow[];
	onApplyPushIntentRecovery?: (intentId: string) => void;
	onArchivePushIntentRecovery?: (intentId: string) => void;
	openFile?: (path: string) => void;
}

export interface ValidationDiagnosticsIssue {
	filePath: string;
	property: string | null;
	severity: "error" | "warning";
	reason: string;
}

export function buildDiagnosticsRows(
	settings: NotionFreezeSettings,
	options: DiagnosticsOptions = {}
): DatabaseDiagnosticsRow[] {
	return settings.databases.map((entry) => {
		const pushFolderExists = options.folderExists?.(entry, "");
		const pushDecision = evaluatePushSafety({
			settings,
			entry,
			folderExists: pushFolderExists,
			allowDisabledEntry: true,
		});
		const pullDecision = evaluatePullSafety({ settings, entry });
		const folder = pushDecision.pathModel.pushSourceFolder;
		const staleIdCandidateCount = options.staleIdCandidateCount?.(entry, folder) ?? 0;
		return {
			entryId: entry.id,
			name: entry.name,
			pushSourceFolder: folder,
			pullTargetFolder: pullDecision.pathModel.pullTargetFolder,
			pushReadiness: readiness(pushDecision.hardBlocks.length, pushDecision.warnings.length),
			pushReason: reason(pushDecision.hardBlocks[0]?.message, pushDecision.warnings[0]?.message, `Ready: Push scans ${folder}`),
			pullReadiness: readiness(pullDecision.hardBlocks.length, pullDecision.warnings.length),
			pullReason: reason(pullDecision.hardBlocks[0]?.message, pullDecision.warnings[0]?.message, `Ready: Pull writes ${pullDecision.pathModel.pullTargetFolder}`),
			lastPushedAt: entry.lastPushedAt,
			lastPulledAt: entry.lastPulledAt,
			conflictCount: settings.pendingConflicts.filter((conflict) => !conflict.entryId || conflict.entryId === entry.id).length,
				duplicateNotionIdCount: options.duplicateNotionIdCount?.(entry) ?? 0,
				staleIdCandidateCount,
				staleIdThresholdWarn: staleIdCandidateCount > 5,
				backfilledFileCount: options.backfilledFileCount?.(entry) ?? 0,
				validationIssues: validationIssuesFromSyncErrors(entry.lastSyncErrors),
			};
		});
	}

export function renderDiagnosticsPanel(
	containerEl: HTMLElement,
	settings: NotionFreezeSettings,
	options: DiagnosticsOptions = {}
): void {
	const panel = containerEl.createDiv({ cls: "stonerelay-diagnostics-panel" });
	panel.createEl("h3", { text: "Diagnostics" });
	const rows = buildDiagnosticsRows(settings, options);
	renderActiveOperations(panel, options.activeOperations ?? []);
	renderPushIntentRecoveries(panel, options);
	renderVaultCanonicalRows(panel, options.vaultCanonicalRows ?? []);
	if (rows.length === 0) {
		panel.createEl("p", {
			cls: "setting-item-description",
			text: "No databases configured.",
		});
		return;
	}
	for (const row of rows) {
		const item = panel.createDiv({ cls: "stonerelay-diagnostics-row" });
		item.createEl("h4", { text: row.name });
		item.createEl("p", { text: `Push source: ${row.pushSourceFolder}` });
		item.createEl("p", { text: `Pull target: ${row.pullTargetFolder}` });
		item.createEl("p", { text: `Push readiness: ${row.pushReadiness} - ${row.pushReason}` });
		item.createEl("p", { text: `Pull readiness: ${row.pullReadiness} - ${row.pullReason}` });
		item.createEl("p", { text: `Last push: ${row.lastPushedAt ?? "Never"} · Last pull: ${row.lastPulledAt ?? "Never"}` });
		item.createEl("p", { text: `Conflicts: ${row.conflictCount} · Duplicate notion-id files: ${row.duplicateNotionIdCount}` });
			item.createEl("p", {
				text: `Stale-ID candidates: ${row.staleIdCandidateCount}${row.staleIdThresholdWarn ? " ⚠" : ""}`,
			});
			item.createEl("p", { text: `Backfilled legacy files: ${row.backfilledFileCount}` });
			renderValidationIssues(item, row.validationIssues, options.openFile);
		}
}

function renderVaultCanonicalRows(panel: HTMLElement, rows: VaultCanonicalDiagnosticsRow[]): void {
	const section = panel.createDiv({ cls: "stonerelay-vault-canonical-ids" });
	section.createEl("h4", { text: "Vault Canonical IDs" });
	if (rows.length === 0) {
		section.createEl("p", { cls: "setting-item-description", text: "No vault-canonical ID diagnostics." });
		return;
	}
	for (const row of rows) {
		const item = section.createDiv({ cls: "stonerelay-vault-canonical-row" });
		item.createEl("p", { text: `${row.name}: mirror ${row.mirrorProperty ?? "not configured"}` });
		item.createEl("p", { text: `.next-id: ${row.nextIdPresent ? row.nextIdValue ?? "invalid" : "absent"}` });
		item.createEl("p", { text: `.next-id.lock: ${row.lockPresent ? "present (informational)" : "absent"}` });
		item.createEl("p", { text: `Notion unique_id max observed: ${row.lastObservedUniqueIdMax ?? "unknown"}` });
		item.createEl("p", { text: `Awaiting ID stamp: ${row.awaitingStampCount}` });
		if (row.midBootstrap) {
			item.createEl("p", { cls: "setting-item-description", text: "Mid-bootstrap detected: .next-id exists but mirror property is not configured." });
		}
		if (row.sequenceLag) {
			item.createEl("p", { cls: "setting-item-description", text: "Sequence lag: vault .next-id may be behind Notion unique_id." });
		}
		if (row.nextIdParseError) {
			item.createEl("p", { cls: "setting-item-description", text: row.nextIdParseError });
		}
	}
}

function renderValidationIssues(
	container: HTMLElement,
	issues: ValidationDiagnosticsIssue[],
	openFile?: (path: string) => void
): void {
	if (issues.length === 0) return;
	const section = container.createDiv({ cls: "stonerelay-validation-section" });
	section.createEl("h4", { text: "Frontmatter validation" });
	const sorted = [...issues].sort((a, b) => {
		if (a.severity === b.severity) return a.filePath.localeCompare(b.filePath);
		return a.severity === "error" ? -1 : 1;
	});
	for (const issue of sorted) {
		const row = section.createDiv({ cls: `stonerelay-validation-row stonerelay-${issue.severity}` });
		row.createEl("span", {
			cls: "stonerelay-validation-icon",
			text: issue.severity === "error" ? "✕" : "⚠",
		});
		const fileLink = row.createEl("a", {
			text: issue.filePath,
			cls: "stonerelay-validation-file",
		});
		fileLink.addEventListener("click", () => openFile?.(issue.filePath));
		row.createEl("span", {
			cls: "stonerelay-validation-prop",
			text: issue.property ?? "—",
		});
		row.createEl("span", {
			cls: "stonerelay-validation-reason",
			text: issue.reason,
		});
	}
}

function renderPushIntentRecoveries(panel: HTMLElement, options: DiagnosticsOptions): void {
	const recoveries = options.pushIntentRecoveries ?? [];
	const section = panel.createDiv({ cls: "stonerelay-push-intent-recoveries" });
	section.createEl("h4", { text: "Push intent recovery" });
	if (recoveries.length === 0) {
		section.createEl("p", { cls: "setting-item-description", text: "No pending push intent recoveries." });
		return;
	}
	for (const recovery of recoveries) {
		const item = section.createDiv({ cls: "stonerelay-push-intent-recovery" });
		item.createEl("p", { text: recovery.message });
			const apply = item.createEl("button", { text: "Apply canonical fields" });
		apply.type = "button";
		apply.addEventListener("click", () => options.onApplyPushIntentRecovery?.(recovery.intentId));
		const archive = item.createEl("button", { text: "Archive orphan in Notion" });
		archive.type = "button";
		archive.addEventListener("click", () => options.onArchivePushIntentRecovery?.(recovery.intentId));
	}
}

function renderActiveOperations(panel: HTMLElement, operations: ActiveReservationSnapshot[]): void {
	const section = panel.createDiv({ cls: "stonerelay-active-operations" });
	section.createEl("h4", { text: "Active operations" });
	if (operations.length === 0) {
		section.createEl("p", { cls: "setting-item-description", text: "No active operations." });
		return;
	}
	const table = section.createEl("table");
	const head = table.createEl("thead").createEl("tr");
	for (const label of ["Start time", "Type", "Entry id"]) {
		head.createEl("th", { text: label });
	}
	const body = table.createEl("tbody");
	for (const operation of operations) {
		const row = body.createEl("tr");
		row.createEl("td", { text: operation.startedAt });
		row.createEl("td", { text: operation.type });
		row.createEl("td", { text: operation.entryId });
	}
}

function validationIssuesFromSyncErrors(errors: SyncError[]): ValidationDiagnosticsIssue[] {
	return errors
		.filter((error) => error.errorCode === "schema_mismatch")
		.map((error) => ({
			filePath: error.rowId,
			property: error.property ?? null,
			severity: error.severity ?? "error",
			reason: error.error,
		}));
}

function readiness(blockers: number, warnings: number): DiagnosticsReadiness {
	if (blockers > 0) return "BLOCKED";
	if (warnings > 0) return "WARNING";
	return "PASS";
}

function reason(blocker: string | undefined, warning: string | undefined, fallback: string): string {
	return blocker ?? warning ?? fallback;
}
