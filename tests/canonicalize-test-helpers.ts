import { TFile, TFolder } from "obsidian";
import { vi } from "vitest";
import NotionFreezePlugin from "../src/main";
import { ReservationManager } from "../src/reservations";
import type { ReservationContext } from "../src/reservations";
import { migrateData } from "../src/settings-data";
import type { PushIntentRecovery } from "../src/push-intents";

export interface MemoryAdapter {
	files: Map<string, string>;
	write: ReturnType<typeof vi.fn>;
	read: ReturnType<typeof vi.fn>;
	rename?: ReturnType<typeof vi.fn>;
	remove: ReturnType<typeof vi.fn>;
}

export function makePushApp(
	initialFiles: Array<[string, string]>,
	options: { folderPath?: string; rename?: boolean } = {}
) {
	const folderPath = options.folderPath ?? "_relay/bugs";
	const folder = Object.assign(Object.create(TFolder.prototype), { path: folderPath });
	const files = new Map(initialFiles);
	const tFiles = initialFiles.map(([path]) => makeFile(path, folder));
	const byPath = new Map(tFiles.map((file) => [file.path, file]));
	const adapter = memoryAdapter(initialFiles, options.rename ?? true);
	const app = {
		vault: {
			adapter,
			getAbstractFileByPath: vi.fn((path: string) => {
				if (path === folderPath) return folder;
				return byPath.get(path) ?? null;
			}),
			getMarkdownFiles: vi.fn(() => tFiles),
			cachedRead: vi.fn(async (file: TFile) => adapter.files.get(file.path) ?? files.get(file.path) ?? ""),
		},
	};
	return { app, adapter, files: adapter.files, tFiles };
}

export function memoryAdapter(initial: Array<[string, string]> = [], withRename = true): MemoryAdapter {
	const adapter: MemoryAdapter = {
		files: new Map<string, string>(initial),
		write: vi.fn(async (path: string, data: string) => {
			adapter.files.set(path, data);
		}),
		read: vi.fn(async (path: string) => adapter.files.get(path) ?? ""),
		remove: vi.fn(async (path: string) => {
			adapter.files.delete(path);
		}),
	};
	if (withRename) {
		adapter.rename = vi.fn(async (from: string, to: string) => {
			const data = adapter.files.get(from);
			if (data === undefined) throw new Error("missing temp");
			adapter.files.set(to, data);
			adapter.files.delete(from);
		});
	}
	return adapter;
}

export function makeFile(path: string, parent?: TFolder): TFile {
	const name = path.slice(path.lastIndexOf("/") + 1);
	return Object.assign(Object.create(TFile.prototype), {
		path,
		name,
		basename: name.replace(/\.md$/, ""),
		extension: "md",
		parent: parent ?? Object.assign(Object.create(TFolder.prototype), {
			path: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
		}),
		stat: { mtime: 1 },
	});
}

export function makeRecoveryPlugin(
	adapter: MemoryAdapter,
	filePath: string,
	recoveries: PushIntentRecovery[],
	options: { folderPath?: string; databaseId?: string; apiKey?: string } = {}
) {
	const folderPath = options.folderPath ?? filePath.slice(0, filePath.lastIndexOf("/"));
	const folder = Object.assign(Object.create(TFolder.prototype), { path: folderPath });
	const file = makeFile(filePath, folder);
	const plugin = Object.create(NotionFreezePlugin.prototype) as NotionFreezePlugin & Record<string, unknown>;
	plugin.app = {
		vault: {
			adapter,
			getAbstractFileByPath: (path: string) => path === file.path ? file : null,
			cachedRead: async (target: TFile) => adapter.files.get(target.path) ?? "",
		},
		workspace: { trigger: vi.fn() },
	} as never;
	plugin.manifest = { id: "stonerelay", version: "0.9.11" } as never;
	plugin.settings = {
		...migrateData(null),
		apiKey: options.apiKey ?? "ntn_test",
		databases: [{
			id: "db-1",
			name: "Bugs DB",
			databaseId: options.databaseId ?? "db-1",
			outputFolder: folderPath,
			errorLogFolder: "",
			groupId: null,
			source_of_truth: "notion",
			templater_managed: false,
			strictFrontmatterSchema: false,
			nest_under_db_name: false,
			enabled: true,
			autoSync: "inherit",
			lastSyncedAt: null,
			lastSyncStatus: "never",
			lastSyncError: undefined,
			current_sync_id: null,
		}],
	};
	(plugin as any).reservations = new ReservationManager();
	(plugin as any).pushIntentRecoveries = recoveries;
	(plugin as any).atomicWriteEvents = [];
	return { plugin, file };
}

export function makePushClient(options: {
	existingPages?: unknown[];
	createResponse?: unknown;
	updateResponse?: unknown;
	schema?: Record<string, { type: string }>;
	retrieveResponse?: unknown;
} = {}) {
	const schema = options.schema ?? {
		Name: { type: "title" },
		Status: { type: "status" },
	};
	return {
		databases: {
			retrieve: vi.fn().mockResolvedValue({
				title: [richText("Bugs")],
				data_sources: [{ id: "source-1" }],
			}),
		},
		dataSources: {
			retrieve: vi.fn().mockResolvedValue({ properties: schema }),
			query: vi.fn().mockResolvedValue({
				has_more: false,
				results: options.existingPages ?? [],
			}),
		},
		pages: {
			create: vi.fn().mockResolvedValue(options.createResponse ?? pageResponse("created-page")),
			update: vi.fn().mockResolvedValue(options.updateResponse ?? pageResponse("updated-page")),
			retrieve: vi.fn().mockResolvedValue(options.retrieveResponse ?? pageResponse("created-page")),
		},
	};
}

export function pageResponse(
	id: string,
	options: { title?: string; uniqueId?: string | null; url?: string; lastEdited?: string } = {}
) {
	const properties: Record<string, unknown> = {
		Name: {
			type: "title",
			title: [richText(options.title ?? "New")],
		},
	};
	if (options.uniqueId !== null) {
		properties.ID = uniqueIdProperty(options.uniqueId ?? "ADV-462");
	}
	return {
		object: "page",
		id,
		url: options.url ?? `https://www.notion.so/${id}`,
		last_edited_time: options.lastEdited ?? "2026-04-29T01:23:45.678Z",
		parent: { database_id: "db-1" },
		properties,
	};
}

export function existingPage(id: string, title: string) {
	return {
		object: "page",
		id,
		properties: {
			Name: {
				type: "title",
				title: [richText(title)],
			},
		},
	};
}

export function richText(content: string) {
	return {
		type: "text",
		plain_text: content,
		text: { content, link: null },
		annotations: {
			bold: false,
			italic: false,
			strikethrough: false,
			underline: false,
			code: false,
			color: "default",
		},
		href: null,
	};
}

export async function withPushReservation<T>(
	task: (context: ReservationContext) => Promise<T>,
	databaseId = "db-1",
	vaultFolder = "_relay/bugs"
): Promise<T> {
	const manager = new ReservationManager();
	const reservation = await manager.acquire({
		entryId: "test-push",
		entryName: "Push helper test",
		databaseId,
		vaultFolder,
		type: "push",
		policy: "manual",
	});
	try {
		return await task(reservation.context);
	} finally {
		reservation.release();
	}
}

function uniqueIdProperty(value: string) {
	const match = value.match(/^(.+)-(\d+)$/);
	return {
		type: "unique_id",
		unique_id: {
			prefix: match ? match[1] : null,
			number: match ? Number(match[2]) : Number(value),
		},
	};
}
