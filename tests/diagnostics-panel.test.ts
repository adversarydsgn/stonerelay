import { describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import { buildDiagnosticsRows, renderDiagnosticsPanel } from "../src/diagnostics-panel";
import { NotionFreezeSettingTab } from "../src/settings";
import { NotionFreezeSettings, SyncedDatabase } from "../src/types";

const rawId = "0123456789abcdef0123456789abcdef";

function database(overrides: Partial<SyncedDatabase> = {}): SyncedDatabase {
	return {
		id: overrides.id ?? "db-1",
		name: overrides.name ?? "Bugs DB",
		databaseId: overrides.databaseId ?? rawId,
		outputFolder: overrides.outputFolder ?? "3. System",
		errorLogFolder: overrides.errorLogFolder ?? "",
		groupId: overrides.groupId ?? null,
		autoSync: overrides.autoSync ?? "inherit",
		direction: overrides.direction ?? "bidirectional",
		enabled: overrides.enabled ?? true,
		lastSyncedAt: overrides.lastSyncedAt ?? null,
		lastSyncStatus: overrides.lastSyncStatus ?? "never",
		lastSyncError: overrides.lastSyncError,
		lastPulledAt: overrides.lastPulledAt ?? null,
		lastPushedAt: overrides.lastPushedAt ?? null,
		current_phase: overrides.current_phase ?? "phase_2",
		initial_seed_direction: overrides.initial_seed_direction ?? "pull",
		source_of_truth: overrides.source_of_truth ?? "notion",
		first_sync_completed_at: overrides.first_sync_completed_at ?? null,
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

describe("diagnostics panel rows", () => {
	it("renders an empty state model for an empty database list", () => {
		expect(buildDiagnosticsRows(settings([]))).toEqual([]);
	});

	it("shows green readiness for a database with passable pull and push gates", () => {
		const data = settings([database({
			lastPulledAt: "2026-04-27T10:00:00.000Z",
			lastPushedAt: "2026-04-27T11:00:00.000Z",
		})]);

		expect(buildDiagnosticsRows(data)[0]).toMatchObject({
			pushReadiness: "PASS",
			pullReadiness: "PASS",
			pushSourceFolder: "3. System/Bugs DB",
			pullTargetFolder: "3. System/Bugs DB",
			lastPulledAt: "2026-04-27T10:00:00.000Z",
			lastPushedAt: "2026-04-27T11:00:00.000Z",
		});
	});

	it("shows BLOCKED with shared resolved content folder reasons", () => {
		const data = settings([
			database({ id: "bugs", name: "Bugs DB", outputFolder: "3. System", nest_under_db_name: false }),
			database({ id: "sessions", name: "Sessions DB", databaseId: "11111111111141118111111111111111", outputFolder: "3. System", nest_under_db_name: false }),
		]);

		expect(buildDiagnosticsRows(data)[0]).toMatchObject({
			pushReadiness: "BLOCKED",
		});
		expect(buildDiagnosticsRows(data)[0].pushReason).toContain("with Sessions DB");
		expect(buildDiagnosticsRows(data)[0].pushReason).toContain("shared resolved content folder");
	});

	it("shows stale-ID candidate counts with a threshold warning icon trigger", () => {
		const data = settings([database()]);

		expect(buildDiagnosticsRows(data, {
			staleIdCandidateCount: () => 6,
			duplicateNotionIdCount: () => 2,
			backfilledFileCount: () => 1,
		})[0]).toMatchObject({
			staleIdCandidateCount: 6,
			staleIdThresholdWarn: true,
			duplicateNotionIdCount: 2,
			backfilledFileCount: 1,
		});
	});

	it("settings tab wires live diagnostics providers into the rendered panel", () => {
		const entry = database();
		const duplicateA = tfile("3. System/Bugs DB/a.md");
		const duplicateB = tfile("3. System/Bugs DB/b.md");
		const app = {
			vault: { getMarkdownFiles: () => [duplicateA, duplicateB] },
			metadataCache: {
				getFileCache: () => ({
					frontmatter: {
						"notion-id": "page-1",
						"notion-database-id": rawId,
					},
				}),
			},
		};
		const plugin = {
			settings: settings([entry]),
			manifest: { version: "0.9.8" },
			getLastBackfilledFileCount: vi.fn(() => 3),
			getActiveOperationSnapshots: vi.fn(() => [{
				id: "reservation-1",
				entryId: entry.id,
				entryName: entry.name,
				databaseId: entry.databaseId,
				vaultFolder: "3. System/Bugs DB",
				type: "pull",
				startedAt: "2026-04-28T10:00:00.000Z",
			}]),
			getPushIntentRecoveries: vi.fn(() => [{
					intentId: "intent-1",
					vaultPath: "3. System/Bugs DB/new.md",
					notionId: "page-new",
					phase: "created",
					message: "Push recovery needs action",
				}]),
			applyPushIntentRecovery: vi.fn(),
			archivePushIntentRecovery: vi.fn(),
		};
		const tab = new NotionFreezeSettingTab(app as never, plugin as never);
		const root = fakeElement("root");

		(tab as unknown as { renderDiagnostics: (el: HTMLElement) => void }).renderDiagnostics(root as never);
		const text = flattenText(root).join("\n");

		expect(text).toContain("Active operations");
		expect(text).toContain("2026-04-28T10:00:00.000Z");
		expect(text).toContain("Duplicate notion-id files: 1");
		expect(text).toContain("Backfilled legacy files: 3");
		expect(text).toContain("Push recovery needs action");
	});

	it("renders push-intent recovery operator actions", () => {
		const apply = vi.fn();
		const archive = vi.fn();
		const root = fakeElement("root");

		renderDiagnosticsPanel(root as never, settings([database()]), {
			pushIntentRecoveries: [{
					intentId: "intent-1",
					vaultPath: "3. System/Bugs DB/new.md",
					notionId: "page-new",
					phase: "created",
					message: "Push recovery needs action",
				}],
			onApplyPushIntentRecovery: apply,
			onArchivePushIntentRecovery: archive,
		});

			clickButton(root, "Apply canonical fields");
		clickButton(root, "Archive orphan in Notion");

		expect(apply).toHaveBeenCalledWith("intent-1");
		expect(archive).toHaveBeenCalledWith("intent-1");
	});
});

function tfile(path: string): TFile {
	const name = path.slice(path.lastIndexOf("/") + 1);
	return Object.assign(Object.create(TFile.prototype), {
		path,
		name,
		basename: name.replace(/\.md$/, ""),
		extension: "md",
	});
}

function fakeElement(tag: string): any {
	return {
		tag,
		textContent: "",
		children: [] as any[],
		listeners: new Map<string, () => void>(),
		createDiv(options?: { cls?: string }) {
			const child = fakeElement("div");
			child.cls = options?.cls;
			this.children.push(child);
			return child;
		},
		createEl(childTag: string, options?: { text?: string; cls?: string }) {
			const child = fakeElement(childTag);
			child.textContent = options?.text ?? "";
			child.cls = options?.cls;
			this.children.push(child);
			return child;
		},
		addEventListener(event: string, callback: () => void) {
			this.listeners.set(event, callback);
		},
	};
}

function flattenText(element: any): string[] {
	return [
		element.textContent,
		...element.children.flatMap((child: any) => flattenText(child)),
	].filter(Boolean);
}

function clickButton(element: any, text: string): void {
	if (element.tag === "button" && element.textContent === text) {
		element.listeners.get("click")?.();
		return;
	}
	for (const child of element.children) clickButton(child, text);
}
