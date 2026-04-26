import { Client } from "@notionhq/client";
import { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints";

export interface NotionFreezeSettings {
	apiKey: string;
	defaultOutputFolder: string;
	databases: SyncedDatabase[];
	pendingConflicts: Conflict[];
	schemaVersion: number;
}

export const DEFAULT_SETTINGS: NotionFreezeSettings = {
	apiKey: "",
	defaultOutputFolder: "Notion",
	databases: [],
	pendingConflicts: [],
	schemaVersion: 4,
};

export type SyncStatus = "ok" | "partial" | "cancelled" | "error" | "interrupted" | "never" | null;
export type SyncDirection = "pull" | "push" | "bidirectional";
export type SyncPhase = "phase_1" | "phase_2";
export type SourceOfTruth = "notion" | "obsidian" | "manual_merge";
export type SyncRunType = "full" | "retry";

export interface SyncError {
	rowId: string;
	direction: "pull" | "push";
	error: string;
	errorCode?: "notion_4xx" | "notion_5xx" | "vault_io" | "schema_mismatch" | "rate_limit" | "network";
	timestamp: string;
}

export interface Conflict {
	rowId: string;
	notionEditedAt: string;
	vaultEditedAt: string;
	notionSnapshot: Record<string, unknown>;
	vaultSnapshot: Record<string, unknown>;
	detectedAt: string;
}

export interface SyncedDatabase {
	id: string;
	name: string;
	databaseId: string;
	outputFolder: string;
	direction: SyncDirection;
	enabled: boolean;
	lastSyncedAt: string | null;
	lastSyncStatus: SyncStatus;
	lastSyncError?: string;
	lastPulledAt: string | null;
	lastPushedAt: string | null;
	current_phase: SyncPhase;
	initial_seed_direction: "pull" | "push" | null;
	source_of_truth: SourceOfTruth | null;
	first_sync_completed_at: string | null;
	nest_under_db_name: boolean;
	current_sync_id: string | null;
	lastCommittedRowId: string | null;
	lastSyncErrors: SyncError[];
}

export interface FreezeFrontmatter {
	"notion-id": string;
	"notion-url": string;
	"notion-frozen-at": string;
	"notion-last-edited": string;
	"notion-database-id"?: string;
	"notion-deleted"?: boolean;
	[key: string]: unknown;
}

export interface PageWriteOptions {
	client: Client;
	page: PageObjectResponse;
	outputFolder: string;
	databaseId: string;
}

export interface PageWriteResult {
	status: "created" | "updated";
	filePath: string;
	title: string;
}

export interface DatabaseSyncResult {
	title: string;
	folderPath: string;
	total: number;
	created: number;
	updated: number;
	skipped: number;
	deleted: number;
	failed: number;
	errors: string[];
}

export type ProgressPhase =
	| { phase: "querying" }
	| { phase: "diffing" }
	| { phase: "detected"; staleCount: number; total: number }
	| { phase: "importing"; current: number; total: number }
	| { phase: "done" };

export type ProgressCallback = (progress: ProgressPhase) => void;

export interface SyncRunOptions {
	signal?: AbortSignal;
	startAfterRowId?: string | null;
	retryRowIds?: string[];
	nestUnderDbName?: boolean;
	bidirectional?: {
		sourceOfTruth: SourceOfTruth | null;
		lastSyncedAt?: string | null;
		onConflict?: (conflict: Conflict) => void;
	};
	onRowCommitted?: (rowId: string) => void;
	onRowError?: (error: SyncError) => void;
}
