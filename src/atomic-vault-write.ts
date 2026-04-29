import { TFile } from "obsidian";
import { PluginDataAdapter } from "./plugin-data";
import { withReservationPathLock } from "./reservations";
import { isForbiddenLockfileWritePath } from "./vault-canonical";

export class AtomicWriteUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AtomicWriteUnavailableError";
	}
}

export class LockfileWriteForbiddenError extends Error {
	constructor(path: string) {
		super(`Stonerelay must not write to lockfile path: ${path}`);
		this.name = "LockfileWriteForbiddenError";
	}
}

export interface AtomicVaultLike {
	adapter?: PluginDataAdapter;
	getAbstractFileByPath?: (path: string) => unknown;
	read?: (file: TFile) => Promise<string>;
}

export interface AtomicWriteOptions {
	onCommitted?: (path: string) => void;
}

export async function writeAtomic(
	vault: AtomicVaultLike,
	path: string,
	content: string,
	options: AtomicWriteOptions = {}
): Promise<void> {
	if (isForbiddenLockfileWritePath(path)) {
		throw new LockfileWriteForbiddenError(path);
	}
	const adapter = vault.adapter;
	if (!adapter?.write) {
		throw new AtomicWriteUnavailableError(`Atomic vault write unavailable for ${path}: adapter.write is not available.`);
	}
	const write = adapter.write.bind(adapter);
	const tempPath = `${path}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	let tempCreated = false;
	try {
		await write(tempPath, content);
		tempCreated = true;
		if (adapter.rename) {
			try {
				await adapter.rename(tempPath, path);
				tempCreated = false;
				options.onCommitted?.(path);
				return;
			} catch (err) {
				if (!isFallbackRenameError(err)) throw err;
			}
		}
		await withReservationPathLock(path, async () => {
			if (adapter.read) {
				const tempContent = await adapter.read(tempPath);
				if (tempContent !== content) {
					throw new AtomicWriteUnavailableError(`Atomic vault write verification failed for ${path}.`);
				}
			}
			await write(path, content);
			options.onCommitted?.(path);
		});
	} catch (err) {
		if (err instanceof AtomicWriteUnavailableError) throw err;
		throw new AtomicWriteUnavailableError(`Atomic vault write failed for ${path}: ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		if (tempCreated) {
			await adapter.remove?.(tempPath).catch(() => undefined);
		}
	}
}

export async function modifyAtomic(
	vault: AtomicVaultLike,
	file: TFile,
	content: string,
	options: AtomicWriteOptions = {}
): Promise<void> {
	await writeAtomic(vault, file.path, content, options);
}

function isFallbackRenameError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /destination file already exists|target exists|file already exists|rename|not available|undefined/i.test(message);
}
