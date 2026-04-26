export interface PluginDataAdapter {
	write?: (path: string, data: string) => Promise<void>;
	read?: (path: string) => Promise<string>;
	rename?: (from: string, to: string) => Promise<void>;
	remove?: (path: string) => Promise<void>;
}

export async function writePluginDataAtomic(
	adapter: PluginDataAdapter,
	dataPath: string,
	payload: string,
	fallbackSaveData: () => Promise<void>
): Promise<void> {
	if (!adapter.write) {
		console.warn("Stonerelay: Obsidian adapter does not expose write(); falling back to Plugin.saveData without atomic rename.");
		await fallbackSaveData();
		return;
	}
	const tempPath = `${dataPath}.tmp-${Date.now()}`;
	await adapter.write(tempPath, payload);
	if (!adapter.rename) {
		await writeConfirmedFallback(adapter, tempPath, dataPath, payload, "Stonerelay: Obsidian adapter lacks rename(); using write-confirm-remove fallback for data.json.");
		return;
	}
	try {
		await adapter.rename(tempPath, dataPath);
	} catch (err) {
		await writeConfirmedFallback(adapter, tempPath, dataPath, payload, `Stonerelay: adapter rename failed (${errorMessage(err)}); using write-confirm-remove fallback for data.json.`);
	}
}

async function writeConfirmedFallback(
	adapter: PluginDataAdapter,
	tempPath: string,
	dataPath: string,
	payload: string,
	message: string
): Promise<void> {
	console.warn(message);
	if (adapter.read) {
		const tempPayload = await adapter.read(tempPath);
		if (tempPayload !== payload) throw new Error("Atomic settings write verification failed.");
	}
	await adapter.write?.(dataPath, payload);
	await adapter.remove?.(tempPath).catch(() => undefined);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
