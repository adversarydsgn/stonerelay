import { SyncDirection, SyncError, SyncRunType, SyncedDatabase } from "./types";

export class SyncCancelled extends Error {
	constructor() {
		super("Sync cancelled");
		this.name = "SyncCancelled";
	}
}

export function assertNotCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new SyncCancelled();
	}
}

export function sourceOfTruthForDirection(
	direction: SyncDirection
): "notion" | "obsidian" {
	return direction === "push" ? "obsidian" : "notion";
}

export function applyPhaseTransition(
	entry: SyncedDatabase,
	status: SyncedDatabase["lastSyncStatus"],
	errors: SyncError[],
	runType: SyncRunType,
	timestamp: string
): SyncedDatabase {
	const next: SyncedDatabase = {
		...entry,
		lastSyncStatus: status,
		lastSyncErrors: errors,
	};

	if (
		next.current_phase === "phase_1" &&
		status === "ok" &&
		errors.length === 0 &&
		runType === "full"
	) {
		next.current_phase = "phase_2";
		next.first_sync_completed_at = timestamp;
		next.source_of_truth = sourceOfTruthForDirection(
			next.initial_seed_direction ?? next.direction
		);
	}

	return next;
}

export function syncErrorsFromMessages(
	messages: string[],
	direction: "pull" | "push",
	timestamp: string
): SyncError[] {
	return messages.map((message) => {
		const rowId = message.split(":")[0]?.trim() || "unknown";
		return {
			rowId,
			direction,
			error: message,
			errorCode: classifyError(message),
			timestamp,
		};
	});
}

export function classifyError(
	message: string
): SyncError["errorCode"] | undefined {
	const lower = message.toLowerCase();
	if (lower.includes("rate")) return "rate_limit";
	if (lower.includes("network") || lower.includes("fetch")) return "network";
	if (lower.includes("schema")) return "schema_mismatch";
	if (lower.includes("vault") || lower.includes("file") || lower.includes("folder")) return "vault_io";
	if (lower.includes("4")) return "notion_4xx";
	if (lower.includes("5")) return "notion_5xx";
	return undefined;
}

export function commitRow<T>(
	rowId: string,
	commit: () => Promise<T>,
	onCommitted?: (rowId: string) => void
): Promise<T> {
	return commit().then((result) => {
		onCommitted?.(rowId);
		return result;
	});
}

