import { Client } from "@notionhq/client";
import { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints";

export interface NotionFreezeSettings {
	apiKey: string;
	defaultOutputFolder: string;
	databases: SyncedDatabase[];
	schemaVersion: number;
}

export const DEFAULT_SETTINGS: NotionFreezeSettings = {
	apiKey: "",
	defaultOutputFolder: "Notion",
	databases: [],
	schemaVersion: 2,
};

export type SyncStatus = "ok" | "error" | "never";

export interface SyncedDatabase {
	id: string;
	name: string;
	databaseId: string;
	outputFolder: string;
	enabled: boolean;
	lastSyncedAt: string | null;
	lastSyncStatus: SyncStatus;
	lastSyncError?: string;
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
