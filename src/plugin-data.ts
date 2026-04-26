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
	const backupPath = `${dataPath}.bak-${Date.now()}`;
	await adapter.write(tempPath, payload);
	if (!adapter.rename) {
		console.warn("Stonerelay: Obsidian adapter lacks rename(); using write-confirm-remove fallback for data.json.");
		if (adapter.read) {
			const tempPayload = await adapter.read(tempPath);
			if (tempPayload !== payload) throw new Error("Atomic settings write verification failed.");
		}
		await adapter.write(dataPath, payload);
		await adapter.remove?.(tempPath).catch(() => undefined);
		return;
	}
	try {
		await adapter.rename(tempPath, dataPath);
	} catch (err) {
		let backedUp = false;
		try {
			await adapter.rename(dataPath, backupPath);
			backedUp = true;
			await adapter.rename(tempPath, dataPath);
			await adapter.remove?.(backupPath).catch(() => undefined);
		} catch (replaceErr) {
			if (backedUp) {
				await adapter.rename?.(backupPath, dataPath).catch(() => undefined);
				await adapter.remove?.(backupPath).catch(() => undefined);
			}
			await adapter.remove?.(tempPath).catch(() => undefined);
			throw backedUp ? replaceErr : err;
		}
	}
}
