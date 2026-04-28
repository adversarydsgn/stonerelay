import { NotionFreezeSettings, SyncedDatabase } from "./types";
import { evaluatePullSafety, evaluatePushSafety } from "./sync-safety";
import { ActiveReservationSnapshot } from "./reservations";

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
}

export interface DiagnosticsOptions {
	folderExists?: (entry: SyncedDatabase, folder: string) => boolean | undefined;
	staleIdCandidateCount?: (entry: SyncedDatabase, folder: string) => number;
	duplicateNotionIdCount?: (entry: SyncedDatabase) => number;
	backfilledFileCount?: (entry: SyncedDatabase) => number;
	activeOperations?: ActiveReservationSnapshot[];
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

function readiness(blockers: number, warnings: number): DiagnosticsReadiness {
	if (blockers > 0) return "BLOCKED";
	if (warnings > 0) return "WARNING";
	return "PASS";
}

function reason(blocker: string | undefined, warning: string | undefined, fallback: string): string {
	return blocker ?? warning ?? fallback;
}
