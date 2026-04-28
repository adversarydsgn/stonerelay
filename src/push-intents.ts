import { createHash } from "crypto";
import { PluginDataAdapter } from "./plugin-data";

export type PushIntentPhase = "creating" | "created" | "committed" | "archived";

export interface PushIntentRecord {
	intent_id: string;
	reservation_id: string;
	vault_path: string;
	title_hash: string;
	phase: PushIntentPhase;
	notion_id?: string;
	started_at?: string;
	completed_at?: string;
}

export interface PushIntentRecovery {
	intentId: string;
	vaultPath: string;
	notionId: string;
	message: string;
}

export interface PushIntentLogger {
	recordCreating(vaultPath: string, title: string): Promise<string>;
	recordCreated(intentId: string, notionId: string): Promise<void>;
	recordCommitted(intentId: string): Promise<void>;
}

export class PushIntentLog implements PushIntentLogger {
	constructor(
		private readonly adapter: PluginDataAdapter,
		private readonly logPath: string,
		private readonly reservationId: string
	) {}

	async recordCreating(vaultPath: string, title: string): Promise<string> {
		const intentId = crypto.randomUUID();
		await appendIntentRecord(this.adapter, this.logPath, {
			intent_id: intentId,
			reservation_id: this.reservationId,
			vault_path: vaultPath,
			title_hash: createHash("sha256").update(title).digest("hex"),
			phase: "creating",
			started_at: new Date().toISOString(),
		});
		return intentId;
	}

	async recordCreated(intentId: string, notionId: string): Promise<void> {
		await appendIntentRecord(this.adapter, this.logPath, {
			intent_id: intentId,
			reservation_id: this.reservationId,
			vault_path: "",
			title_hash: "",
			phase: "created",
			notion_id: notionId,
			completed_at: new Date().toISOString(),
		});
	}

	async recordCommitted(intentId: string): Promise<void> {
		await appendIntentRecord(this.adapter, this.logPath, {
			intent_id: intentId,
			reservation_id: this.reservationId,
			vault_path: "",
			title_hash: "",
			phase: "committed",
			completed_at: new Date().toISOString(),
		});
	}
}

export async function appendIntentRecord(
	adapter: PluginDataAdapter,
	logPath: string,
	record: PushIntentRecord
): Promise<void> {
	if (!adapter.write) throw new Error("Push intent log unavailable: adapter.write is not available.");
	const existing = adapter.read ? await adapter.read(logPath).catch(() => "") : "";
	const payload = `${existing}${JSON.stringify(record)}\n`;
	const tempPath = `${logPath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	await adapter.write(tempPath, payload);
	try {
		if (adapter.rename) {
			try {
				await adapter.rename(tempPath, logPath);
				return;
			} catch {
				// Some adapters cannot replace existing files with rename.
			}
		}
		await adapter.write(logPath, payload);
	} finally {
		await adapter.remove?.(tempPath).catch(() => undefined);
	}
}

export async function recoverPushIntents(
	adapter: PluginDataAdapter,
	logPath: string,
	now = new Date()
): Promise<PushIntentRecovery[]> {
	if (!adapter.read) return [];
	const raw = await adapter.read(logPath).catch(() => "");
	const latest = new Map<string, PushIntentRecord>();
	const created = new Map<string, PushIntentRecord>();
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const record = JSON.parse(line) as PushIntentRecord;
			const previous = latest.get(record.intent_id);
			latest.set(record.intent_id, {
				...previous,
				...record,
				vault_path: record.vault_path || previous?.vault_path || "",
				title_hash: record.title_hash || previous?.title_hash || "",
				notion_id: record.notion_id || previous?.notion_id,
			});
			if (record.phase === "created") created.set(record.intent_id, record);
		} catch {
			continue;
		}
	}

	const recoveries: PushIntentRecovery[] = [];
	for (const [intentId, record] of latest) {
		if (record.phase !== "created" || !record.notion_id) continue;
		if (isOlderThanThirtyDays(record.completed_at ?? record.started_at, now)) {
			await appendIntentRecord(adapter, logPath, {
				...record,
				phase: "archived",
				completed_at: now.toISOString(),
			});
			continue;
		}
		recoveries.push({
			intentId,
			vaultPath: record.vault_path,
			notionId: record.notion_id,
			message: `Push for ${record.vault_path} created Notion page ${record.notion_id} but did not write the id locally. Apply id now? Or delete the orphan Notion page?`,
		});
	}
	return recoveries;
}

function isOlderThanThirtyDays(value: string | undefined, now: Date): boolean {
	if (!value) return false;
	const then = Date.parse(value);
	if (Number.isNaN(then)) return false;
	return now.getTime() - then > 30 * 24 * 60 * 60 * 1000;
}
