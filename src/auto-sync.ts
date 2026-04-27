import { Conflict, NotionFreezeSettings, PageSyncEntry, SyncedDatabase } from "./types";
import { effectiveAutoSyncEnabled } from "./settings-data";

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
		return entry.direction === "push" || entry.direction === "bidirectional";
	}
	return true;
}

export function findAutoSyncEntryForPath(
	settings: NotionFreezeSettings,
	path: string
): AutoSyncEntry | null {
	const normalizedPath = normalizeForCompare(path);
	for (const entry of settings.databases) {
		if (pathStartsWith(normalizedPath, entry.outputFolder)) {
			return { type: "database", entry };
		}
	}
	for (const entry of settings.pages) {
		if (entry.lastFilePath && normalizeForCompare(entry.lastFilePath) === normalizedPath) {
			return { type: "page", entry };
		}
		if (pathStartsWith(normalizedPath, entry.outputFolder)) {
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

function pathStartsWith(path: string, folder: string): boolean {
	const normalizedFolder = normalizeForCompare(folder);
	return Boolean(normalizedFolder) && (path === normalizedFolder || path.startsWith(`${normalizedFolder}/`));
}

function normalizeForCompare(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}
