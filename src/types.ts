import { Client } from "@notionhq/client";
import { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints";
import type { ReservationContext } from "./reservations";

export interface NotionFreezeSettings {
	apiKey: string;
	defaultOutputFolder: string;
	defaultErrorLogFolder: string;
	databases: SyncedDatabase[];
	pages: PageSyncEntry[];
	groups: SyncGroup[];
	pendingConflicts: Conflict[];
	active_reservations: ActiveReservationState[];
	autoSyncEnabled: boolean;
	autoSyncDatabasesByDefault: boolean;
	autoSyncPagesByDefault: boolean;
	schemaVersion: number;
}

export const DEFAULT_SETTINGS: NotionFreezeSettings = {
	apiKey: "",
	defaultOutputFolder: "Notion",
	defaultErrorLogFolder: "",
	databases: [],
	pages: [],
	groups: [],
	pendingConflicts: [],
	active_reservations: [],
	autoSyncEnabled: false,
	autoSyncDatabasesByDefault: false,
	autoSyncPagesByDefault: false,
	schemaVersion: 7,
};

export type SyncStatus = "ok" | "partial" | "cancelled" | "error" | "interrupted" | "never" | null;
export type SyncDirection = "pull" | "push" | "bidirectional";
export type SyncPhase = "phase_1" | "phase_2";
export type SourceOfTruth = "notion" | "obsidian" | "manual_merge";
export type SyncRunType = "full" | "retry";
export type AutoSyncOverride = "inherit" | "on" | "off";

export interface SyncGroup {
	id: string;
	name: string;
	collapsed: boolean;
}

export interface SyncError {
	rowId: string;
	direction: "pull" | "push";
	error: string;
	errorCode?: "notion_4xx" | "notion_5xx" | "vault_io" | "schema_mismatch" | "rate_limit" | "network";
	timestamp: string;
}

export interface Conflict {
	rowId: string;
	entryId?: string;
	entryType?: "database" | "page";
	notionEditedAt: string;
	vaultEditedAt: string;
	notionSnapshot: Record<string, unknown>;
	vaultSnapshot: Record<string, unknown>;
	detectedAt: string;
}

export interface ActiveReservationState {
	id: string;
	entryId: string;
	entryName: string;
	databaseId: string;
	vaultFolder: string;
	type: string;
	startedAt: string;
}

export interface SyncedDatabase {
	id: string;
	name: string;
	databaseId: string;
	outputFolder: string;
	errorLogFolder: string;
	groupId: string | null;
	autoSync: AutoSyncOverride;
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
	templater_managed: boolean;
	first_sync_completed_at: string | null;
	nest_under_db_name: boolean;
	current_sync_id: string | null;
	lastCommittedRowId: string | null;
	lastSyncErrors: SyncError[];
}

export interface PageSyncEntry {
	id: string;
	type: "page";
	name: string;
	pageId: string;
	outputFolder: string;
	errorLogFolder: string;
	groupId: string | null;
	enabled: boolean;
	autoSync: AutoSyncOverride;
	lastSyncedAt: string | null;
	lastSyncStatus: SyncStatus;
	lastSyncError?: string;
	current_sync_id: string | null;
	lastFilePath: string | null;
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
	context?: ReservationContext;
	onAtomicWriteCommitted?: (path: string) => void;
}

export interface StandalonePageWriteOptions {
	client: Client;
	page: PageObjectResponse;
	outputFolder: string;
	context?: ReservationContext;
	onAtomicWriteCommitted?: (path: string) => void;
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
	warnings?: string[];
	backfilled?: number;
}

export interface AtomicWriteEvent {
	path: string;
	reservationId?: string;
	committedAt: string;
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
	allowStaleNotionIdThresholdProceed?: boolean;
	bidirectional?: {
		sourceOfTruth: SourceOfTruth | null;
		templaterManaged?: boolean;
		lastSyncedAt?: string | null;
		onConflict?: (conflict: Conflict) => void;
	};
	onRowCommitted?: (rowId: string) => void;
	onRowError?: (error: SyncError) => void;
	context?: ReservationContext;
	onPushIntentCreating?: (vaultPath: string, title: string) => Promise<string>;
	onPushIntentCreated?: (intentId: string, notionId: string) => Promise<void>;
	onPushIntentCommitted?: (intentId: string) => Promise<void>;
	onAtomicWriteCommitted?: (path: string) => void;
}
