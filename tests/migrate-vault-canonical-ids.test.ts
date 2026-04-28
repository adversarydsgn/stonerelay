import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatPlan, migrateVaultCanonicalIds, type OperationalDb } from "../scripts/migrate-vault-canonical-ids";

const DB: OperationalDb = {
	prefix: "DEC",
	data_source_id: "dec-source",
	unique_id_property: "ID",
	vault_folder: "3. System/Decisions DB",
};

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("vault-canonical ID bootstrap migration", () => {
	it("seeds .next-id from Notion max unique_id and creates the stable lock target", async () => {
		const vaultRoot = await vaultWithDbFolder(DB);
		const client = clientWithMax(41);

		const plans = await migrateVaultCanonicalIds({
			vaultRoot,
			client,
			dbs: [DB],
			request: (fn) => fn(),
		});

		const folder = path.join(vaultRoot, DB.vault_folder);
		await expect(readFile(path.join(folder, ".next-id"), "utf8")).resolves.toBe("42\n");
		await expect(stat(path.join(folder, ".next-id.lock"))).resolves.toMatchObject({ size: 0 });
		expect(plans[0]).toMatchObject({
			action: "seed",
			nextId: 42,
			priorValue: "missing",
			lockTargetAction: "create",
		});
		expect(formatPlan(plans[0])).toContain("seed .next-id = 42");
		expect(client.dataSources.query).toHaveBeenCalledWith({
			data_source_id: "dec-source",
			sorts: [{ property: "ID", direction: "descending" }],
			page_size: 1,
		});
	});

	it("is idempotent when the vault lockfile is already current", async () => {
		const vaultRoot = await vaultWithDbFolder(DB);
		const folder = path.join(vaultRoot, DB.vault_folder);
		const lockfile = path.join(folder, ".next-id");
		await writeFile(lockfile, "42\n", "utf8");
		await writeFile(path.join(folder, ".next-id.lock"), "", "utf8");
		const before = await stat(lockfile);

		const plans = await migrateVaultCanonicalIds({
			vaultRoot,
			client: clientWithMax(41),
			dbs: [DB],
			request: (fn) => fn(),
		});

		const after = await stat(lockfile);
		expect(plans[0].action).toBe("skip");
		expect(after.mtimeMs).toBe(before.mtimeMs);
		await expect(readFile(lockfile, "utf8")).resolves.toBe("42\n");
	});

	it("fails with a clear missing-folder error", async () => {
		const vaultRoot = await mkdtempRoot();

		await expect(migrateVaultCanonicalIds({
			vaultRoot,
			client: clientWithMax(1),
			dbs: [DB],
			request: (fn) => fn(),
		})).rejects.toThrow("Vault folder missing for 3. System/Decisions DB");
	});

	it("--check plans without writing lockfiles", async () => {
		const vaultRoot = await vaultWithDbFolder(DB);

		const plans = await migrateVaultCanonicalIds({
			vaultRoot,
			client: clientWithMax(9),
			dbs: [DB],
			check: true,
			request: (fn) => fn(),
		});

		expect(plans[0]).toMatchObject({
			check: true,
			action: "seed",
			nextId: 10,
			lockTargetAction: "create",
		});
		expect(formatPlan(plans[0])).toContain("would seed .next-id = 10");
		await expect(readdir(path.join(vaultRoot, DB.vault_folder))).resolves.toEqual([]);
	});
});

async function vaultWithDbFolder(db: OperationalDb): Promise<string> {
	const root = await mkdtempRoot();
	await mkdir(path.join(root, db.vault_folder), { recursive: true });
	return root;
}

async function mkdtempRoot(): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "stonerelay-id-migration-"));
	roots.push(root);
	return root;
}

function clientWithMax(max: number) {
	return {
		dataSources: {
			query: vi.fn(async () => ({
				object: "list",
				type: "page_or_data_source",
				page_or_data_source: {},
				next_cursor: null,
				has_more: false,
				results: [{
					object: "page",
					id: "page-id",
					properties: {
						ID: {
							id: "id",
							type: "unique_id",
							unique_id: { prefix: "DEC", number: max },
						},
					},
				}],
			})),
		},
	};
}
