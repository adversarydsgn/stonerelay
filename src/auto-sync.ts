import { Conflict, NotionFreezeSettings, PageSyncEntry, SyncedDatabase } from "./types";
import { effectiveAutoSyncEnabled } from "./settings-data";
import { normalizeForCompare, pathStartsWith, resolveDatabasePathModel, resolvePagePathModel } from "./path-model";

export type AutoSyncEntry =
	| { type: "database"; entry: SyncedDatabase }
	| { type: "page"; entry: PageSyncEntry };

export interface AutoSyncJob {
	entryId: string;
	entryType: "database" | "page";
	path: string;
	runType: "push" | "refresh";
}

export interface AutoSyncRunner {
	(job: AutoSyncJob): Promise<void>;
}

const BLOCKED_STATUSES = new Set(["partial", "error", "cancelled", "interrupted"]);

export function isAutoSyncEligible(
	settings: NotionFreezeSettings,
	candidate: AutoSyncEntry,
	conflicts: Conflict[] = settings.pendingConflicts
): boolean {
	const { entry, type } = candidate;
	if (!entry.enabled) return false;
	if (!effectiveAutoSyncEnabled(settings, entry, type)) return false;
	if (entry.current_sync_id) return false;
	if (conflicts.some((conflict) => !conflict.entryId || conflict.entryId === entry.id)) return false;
	if (entry.lastSyncStatus && BLOCKED_STATUSES.has(entry.lastSyncStatus)) return false;
	if (!entry.outputFolder.trim()) return false;
	if (type === "database") {
		return false;
	}
	return true;
}

export function findAutoSyncEntryForPath(
	settings: NotionFreezeSettings,
	path: string
): AutoSyncEntry | null {
	const exactPage = settings.pages.find((entry) =>
		resolvePagePathModel(settings, entry).pageFilePath &&
		normalizeForCompare(resolvePagePathModel(settings, entry).pageFilePath ?? "") === normalizeForCompare(path)
	);
	if (exactPage) return { type: "page", entry: exactPage };

	const databaseMatches = settings.databases.filter((entry) =>
		pathStartsWith(path, resolveDatabasePathModel(settings, entry).pushSourceFolder)
	);
	if (databaseMatches.length === 1) return { type: "database", entry: databaseMatches[0] };
	if (databaseMatches.length > 1) return null;

	for (const entry of settings.pages) {
		if (pathStartsWith(path, resolvePagePathModel(settings, entry).pageParentFolder)) {
			return { type: "page", entry };
		}
	}
	return null;
}

export function createBackgroundConflict(input: {
	entryId: string;
	entryType: "database" | "page";
	rowId: string;
	notionEditedAt: string;
	vaultEditedAt: string;
	notionSnapshot?: Record<string, unknown>;
	vaultSnapshot?: Record<string, unknown>;
	detectedAt?: string;
}): Conflict {
	return {
		entryId: input.entryId,
		entryType: input.entryType,
		rowId: input.rowId,
		notionEditedAt: input.notionEditedAt,
		vaultEditedAt: input.vaultEditedAt,
		notionSnapshot: { ...(input.notionSnapshot ?? {}) },
		vaultSnapshot: { ...(input.vaultSnapshot ?? {}) },
		detectedAt: input.detectedAt ?? new Date().toISOString(),
	};
}

export class AutoSyncQueue {
	private pending = new Map<string, AutoSyncJob>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private running = false;

	constructor(
		private readonly runner: AutoSyncRunner,
		private readonly debounceMs = 750
	) {}

	enqueue(job: AutoSyncJob): void {
		this.pending.set(jobKey(job), job);
		this.schedule();
	}

	size(): number {
		return this.pending.size;
	}

	async flush(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.running) return;
		this.running = true;
		try {
			const jobs = [...this.pending.values()];
			this.pending.clear();
			for (const job of jobs) {
				await this.runner(job);
			}
		} finally {
			this.running = false;
			if (this.pending.size > 0) this.schedule();
		}
	}

	private schedule(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			void this.flush();
		}, this.debounceMs);
	}
}

function jobKey(job: AutoSyncJob): string {
	return `${job.entryType}:${job.entryId}:${job.path}`;
}
