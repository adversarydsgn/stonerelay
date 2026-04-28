import type { Client } from "@notionhq/client";
import type { QueryDataSourceResponse } from "@notionhq/client/build/src/api-endpoints";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createNotionClient, notionRequest } from "../src/notion-client";

const DEFAULT_VAULT_ROOT = "/Users/adversary/Documents/Obsidian Vaults/adversary";

export interface OperationalDb {
	prefix: string;
	data_source_id: string;
	unique_id_property: string;
	vault_folder: string;
}

export const OPERATIONAL_DBS: ReadonlyArray<OperationalDb> = [
	{
		prefix: "DEC",
		data_source_id: "e1e832b5-2973-471c-8728-25d36948c628",
		unique_id_property: "ID",
		vault_folder: "3. System/Decisions DB",
	},
	{
		prefix: "LOOP",
		data_source_id: "76e18cb8-5399-41bf-aa9a-162f8881931d",
		unique_id_property: "ID",
		vault_folder: "3. System/Open Loops DB",
	},
	{
		prefix: "FRIC",
		data_source_id: "ad5864f5-50a3-41fc-8a5b-007d27314fd3",
		unique_id_property: "ID",
		vault_folder: "3. System/Friction DB",
	},
	{
		prefix: "SES",
		data_source_id: "f820fd2c-8bba-4fb6-afbe-aa8970f4d168",
		unique_id_property: "Session #",
		vault_folder: "3. System/Sessions DB",
	},
];

export interface MigrationPlan {
	prefix: string;
	vaultFolder: string;
	lockfilePath: string;
	lockTargetPath: string;
	notionMaxId: number;
	nextId: number;
	priorValue: number | "missing" | "empty";
	action: "seed" | "update" | "skip";
	lockTargetAction: "create" | "exists";
	check: boolean;
}

export interface MigrationOptions {
	client?: Pick<Client, "dataSources">;
	apiKey?: string;
	vaultRoot?: string;
	check?: boolean;
	dbs?: ReadonlyArray<OperationalDb>;
	request?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export async function migrateVaultCanonicalIds(options: MigrationOptions = {}): Promise<MigrationPlan[]> {
	const vaultRoot = path.resolve(options.vaultRoot ?? DEFAULT_VAULT_ROOT);
	const client = options.client ?? createScriptClient(options.apiKey);
	const request = options.request ?? notionRequest;
	const check = options.check ?? false;
	const plans: MigrationPlan[] = [];

	for (const db of options.dbs ?? OPERATIONAL_DBS) {
		const folderPath = resolveUnderRoot(vaultRoot, db.vault_folder);
		await requireDirectory(folderPath, db.vault_folder);
		const notionMaxId = await queryMaxUniqueId(client, db, request);
		const nextId = notionMaxId + 1;
		const lockfilePath = path.join(folderPath, ".next-id");
		const lockTargetPath = path.join(folderPath, ".next-id.lock");
		const priorValue = await readCurrentNextId(lockfilePath);
		const lockTargetExists = await pathExists(lockTargetPath);
		const action = priorValue === "missing" || priorValue === "empty"
			? "seed"
			: priorValue < nextId
				? "update"
				: "skip";
		const plan: MigrationPlan = {
			prefix: db.prefix,
			vaultFolder: db.vault_folder,
			lockfilePath,
			lockTargetPath,
			notionMaxId,
			nextId,
			priorValue,
			action,
			lockTargetAction: lockTargetExists ? "exists" : "create",
			check,
		};
		plans.push(plan);

		if (check) continue;
		if (action !== "skip") {
			await writeFileAtomic(lockfilePath, `${nextId}\n`);
		}
		if (!lockTargetExists) {
			await createEmptyFile(lockTargetPath);
		}
	}

	return plans;
}

export function formatPlan(plan: MigrationPlan): string {
	const action = plan.check ? `would ${plan.action}` : plan.action;
	const lock = plan.lockTargetAction === "create"
		? `${plan.check ? "would create" : "created"} .next-id.lock`
		: ".next-id.lock exists";
	return `${plan.vaultFolder}: ${action} .next-id = ${plan.nextId} (was: ${plan.priorValue}; Notion max ${plan.prefix}-${plan.notionMaxId}; ${lock})`;
}

export async function runCli(argv = process.argv.slice(2), env = process.env): Promise<void> {
	const args = parseArgs(argv);
	const apiKey = env.NOTION_API_KEY;
	const plans = await migrateVaultCanonicalIds({
		apiKey,
		vaultRoot: args.vaultRoot ?? env.STONERELAY_VAULT_ROOT,
		check: args.check,
	});
	for (const plan of plans) {
		console.log(formatPlan(plan));
	}
}

function createScriptClient(apiKey: string | undefined): Pick<Client, "dataSources"> {
	if (!apiKey) {
		throw new Error("NOTION_API_KEY is required to query operational database max IDs.");
	}
	if (typeof fetch !== "function") {
		throw new Error("Global fetch is unavailable; run this script with a Node runtime that provides fetch.");
	}
	return createNotionClient(apiKey, { fetch: fetch.bind(globalThis) as never });
}

async function queryMaxUniqueId(
	client: Pick<Client, "dataSources">,
	db: OperationalDb,
	request: <T>(fn: () => Promise<T>) => Promise<T>
): Promise<number> {
	const response = await request(() => client.dataSources.query({
		data_source_id: db.data_source_id,
		sorts: [{ property: db.unique_id_property, direction: "descending" }],
		page_size: 1,
	}));
	return extractUniqueIdNumber(response, db.unique_id_property);
}

function extractUniqueIdNumber(response: QueryDataSourceResponse, propertyName: string): number {
	const first = response.results[0];
	if (!first || !("properties" in first)) return 0;
	const idProperty = first.properties[propertyName];
	if (!idProperty || idProperty.type !== "unique_id") return 0;
	return idProperty.unique_id.number ?? 0;
}

async function readCurrentNextId(filePath: string): Promise<number | "missing" | "empty"> {
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch (err) {
		if (isMissingPathError(err)) return "missing";
		throw err;
	}
	const trimmed = raw.trim();
	if (!trimmed) return "empty";
	if (!/^\d+$/.test(trimmed)) {
		throw new Error(`${filePath} must contain a single integer, found ${JSON.stringify(trimmed)}.`);
	}
	return Number(trimmed);
}

async function requireDirectory(folderPath: string, label: string): Promise<void> {
	try {
		const info = await stat(folderPath);
		if (!info.isDirectory()) {
			throw new Error(`${label} is not a directory: ${folderPath}`);
		}
	} catch (err) {
		if (isMissingPathError(err)) {
			throw new Error(`Vault folder missing for ${label}: ${folderPath}`);
		}
		throw err;
	}
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch (err) {
		if (isMissingPathError(err)) return false;
		throw err;
	}
}

async function createEmptyFile(filePath: string): Promise<void> {
	const handle = await open(filePath, "a");
	await handle.close();
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
	const dir = path.dirname(filePath);
	const base = path.basename(filePath);
	const tempPath = path.join(dir, `${base}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`);
	let tempCreated = false;
	try {
		const handle = await open(tempPath, "w", 0o600);
		tempCreated = true;
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(tempPath, filePath);
		tempCreated = false;
		await fsyncDirectory(dir);
	} finally {
		if (tempCreated) {
			await unlink(tempPath).catch(() => undefined);
		}
	}
}

async function fsyncDirectory(dir: string): Promise<void> {
	let handle;
	try {
		handle = await open(dir, "r");
		await handle.sync();
	} finally {
		await handle?.close();
	}
}

function resolveUnderRoot(root: string, relativePath: string): string {
	const resolved = path.resolve(root, relativePath);
	if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
		throw new Error(`Refusing to resolve path outside vault root: ${relativePath}`);
	}
	return resolved;
}

function parseArgs(argv: string[]): { check: boolean; vaultRoot?: string } {
	const args: { check: boolean; vaultRoot?: string } = { check: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--check") {
			args.check = true;
			continue;
		}
		if (arg === "--vault-root") {
			const value = argv[i + 1];
			if (!value) throw new Error("--vault-root requires a path.");
			args.vaultRoot = value;
			i++;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	return args;
}

function isMissingPathError(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	runCli().catch((err) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exitCode = 1;
	});
}
