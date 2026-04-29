import { TFile, TFolder } from "obsidian";
import { vi } from "vitest";
import { ReservationManager } from "../src/reservations";
import type { ReservationContext } from "../src/reservations";
import { NotionFreezeSettings, SyncedDatabase } from "../src/types";

export function database(overrides: Partial<SyncedDatabase> = {}): SyncedDatabase {
	return {
		id: overrides.id ?? "db-1",
		name: overrides.name ?? "Bugs DB",
		databaseId: overrides.databaseId ?? "0123456789abcdef0123456789abcdef",
		outputFolder: overrides.outputFolder ?? "_relay/A",
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
		templater_managed: overrides.templater_managed ?? false,
		first_sync_completed_at: overrides.first_sync_completed_at ?? null,
		nest_under_db_name: overrides.nest_under_db_name ?? false,
		current_sync_id: overrides.current_sync_id ?? null,
		lastCommittedRowId: overrides.lastCommittedRowId ?? null,
		lastSyncErrors: overrides.lastSyncErrors ?? [],
		strictFrontmatterSchema: overrides.strictFrontmatterSchema ?? false,
		canonical_id_property: overrides.canonical_id_property ?? null,
		last_observed_unique_id_max: overrides.last_observed_unique_id_max ?? null,
	};
}

export function settings(databases: SyncedDatabase[]): NotionFreezeSettings {
	return {
		apiKey: "",
		defaultOutputFolder: "_relay",
		defaultErrorLogFolder: "",
		databases,
		pages: [],
		groups: [],
		pendingConflicts: [],
		active_reservations: [],
		autoSyncEnabled: false,
		autoSyncDatabasesByDefault: false,
		autoSyncPagesByDefault: false,
		schemaVersion: 7,
	};
}

export function pullApp(files: ReturnType<typeof markdownFile>[], extraFiles: Array<[string, string]> = []) {
	const folder = Object.assign(Object.create(TFolder.prototype), { path: "_relay/A", children: files.map((entry) => entry.file) });
	const adapter = {
		files: new Map<string, string>([
			...files.map((entry) => [entry.file.path, entry.content] as [string, string]),
			...extraFiles,
		]),
		write: vi.fn(async (path: string, data: string) => {
			adapter.files.set(path, data);
		}),
		read: vi.fn(async (path: string) => {
			if (!adapter.files.has(path)) throw new Error("not found");
			return adapter.files.get(path) ?? "";
		}),
		rename: vi.fn(async (from: string, to: string) => {
			const data = adapter.files.get(from);
			if (data === undefined) throw new Error("missing temp");
			adapter.files.set(to, data);
			adapter.files.delete(from);
		}),
		remove: vi.fn(async (path: string) => {
			adapter.files.delete(path);
		}),
		stat: vi.fn(async (path: string) => {
			if (!adapter.files.has(path)) throw new Error("missing");
			return { mtime: 1, mtimeMs: 1 };
		}),
	};
	return {
		vault: {
			adapter,
			getAbstractFileByPath: vi.fn((path: string) => path === "_relay/A" ? folder : files.find((entry) => entry.file.path === path)?.file ?? null),
			getMarkdownFiles: vi.fn(() => files.map((entry) => entry.file)),
			read: vi.fn(async (file: TFile) => adapter.files.get(file.path) ?? ""),
		},
		metadataCache: {
			getFileCache: vi.fn((file: TFile) => ({
				frontmatter: files.find((entry) => entry.file === file)?.frontmatter ?? {},
			})),
		},
	};
}

export function markdownFile(path: string, frontmatter: Record<string, unknown>, content?: string) {
	const name = path.slice(path.lastIndexOf("/") + 1);
	return {
		file: Object.assign(Object.create(TFile.prototype), {
			path,
			name,
			basename: name.replace(/\.md$/, ""),
			extension: "md",
			stat: { mtime: 1 },
		}),
		frontmatter,
		content: content ?? `---\n${Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`).join("\n")}\n---\nBody`,
	};
}

export function pullClient(results: unknown[]) {
	return {
		databases: {
			retrieve: vi.fn().mockResolvedValue({
				title: [richText("A")],
				data_sources: [{ id: "source-a" }],
			}),
		},
		dataSources: {
			retrieve: vi.fn().mockResolvedValue({
				title: [richText("A")],
				properties: {
					Name: { type: "title" },
					ID: { type: "unique_id" },
					"Canonical ID": { type: "rich_text" },
				},
			}),
			query: vi.fn().mockResolvedValue({ has_more: false, results }),
		},
		blocks: {
			children: {
				list: vi.fn().mockResolvedValue({ has_more: false, results: [] }),
			},
		},
	};
}

export function page(id: string, title: string, options: { mirror?: string | null; uniqueNumber?: number } = {}) {
	const properties: Record<string, unknown> = {
		Name: { type: "title", title: [richText(title)] },
		ID: { type: "unique_id", unique_id: { prefix: "DEC", number: options.uniqueNumber ?? 461 } },
	};
	if (options.mirror !== undefined) {
		properties["Canonical ID"] = {
			type: "rich_text",
			rich_text: options.mirror ? [richText(options.mirror)] : [],
		};
	}
	return {
		object: "page",
		id,
		url: `https://notion.so/${id}`,
		last_edited_time: "2026-04-27T10:00:00.000Z",
		properties,
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

export async function withPullReservation<T>(task: (context: ReservationContext) => Promise<T>): Promise<T> {
	const manager = new ReservationManager();
	const reservation = await manager.acquire({
		entryId: "test-pull",
		entryName: "Pull helper test",
		databaseId: "db-a",
		vaultFolder: "_relay/A",
		type: "pull",
		policy: "manual",
	});
	try {
		return await task(reservation.context);
	} finally {
		reservation.release();
	}
}

export function fakeElement(tag: string): any {
	return {
		tag,
		children: [] as any[],
		textContent: "",
		listeners: new Map<string, () => void>(),
		createDiv(options?: { cls?: string; text?: string }) {
			const child = fakeElement("div");
			child.cls = options?.cls;
			child.textContent = options?.text ?? "";
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

export function flattenText(element: any): string[] {
	return [
		element.textContent,
		...element.children.flatMap((child: any) => flattenText(child)),
	].filter(Boolean);
}
