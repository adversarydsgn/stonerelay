import { Client, LogLevel } from "@notionhq/client";
import type { ClientOptions } from "@notionhq/client/build/src/Client";

export interface NotionClientOptions {
	fetch: NonNullable<ClientOptions["fetch"]>;
}

export function createNotionClient(apiKey: string, options?: NotionClientOptions): Client {
	if (!options?.fetch) {
		throw new Error("createNotionClient requires options.fetch; use the host-bound client wrapper in plugin code, or pass a Node fetch in scripts");
	}
	return new Client({
		auth: apiKey,
		logLevel: LogLevel.ERROR,
		fetch: options.fetch,
	});
}

const MAX_RETRIES = 5;
const MIN_REQUEST_INTERVAL_MS = 340; // ~3 requests per second

let lastRequestTime = 0;

async function throttle(): Promise<void> {
	const now = Date.now();
	const elapsed = now - lastRequestTime;
	if (elapsed < MIN_REQUEST_INTERVAL_MS) {
		await sleep(MIN_REQUEST_INTERVAL_MS - elapsed);
	}
	lastRequestTime = Date.now();
}

export async function notionRequest<T>(fn: () => Promise<T>): Promise<T> {
	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		await throttle();
		try {
			return await fn();
		} catch (err: unknown) {
			const status = (err as { status?: number }).status;
			const isRetryable =
				status === 429 ||
				status === 500 ||
				status === 502 ||
				status === 503 ||
				status === 504;

			if (isRetryable && attempt < MAX_RETRIES - 1) {
				let delay: number;
				if (status === 429) {
					// Respect Retry-After header (value is in seconds)
					const retryAfter = (err as { headers?: Record<string, string> }).headers?.["retry-after"];
					delay = retryAfter
						? parseFloat(retryAfter) * 1000
						: 1000 * Math.pow(2, attempt);
				} else {
					delay = 1000 * Math.pow(2, attempt);
				}
				// Add jitter: ±25% randomization to avoid thundering herd
				const jitter = delay * 0.25 * (Math.random() * 2 - 1);
				delay = Math.min(delay + jitter, 30000);

				console.warn(
					`Notion API ${status}. Retrying in ${Math.round(delay)}ms ` +
					`(attempt ${attempt + 1}/${MAX_RETRIES})`
				);
				await sleep(delay);
				continue;
			}
			throw err;
		}
	}
	throw new Error("notionRequest: exhausted retries");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Accepts a 32-char hex string, a UUID with dashes, or a full Notion URL.
 * Returns a UUID with dashes.
 */
export function normalizeNotionId(input: string): string {
	let raw = input.trim();

	// Handle full Notion URLs: extract the last 32 hex chars
	if (raw.startsWith("http")) {
		const match = raw.match(/([a-f0-9]{32})/i);
		if (!match) {
			throw new Error(`Could not extract Notion ID from URL: ${raw}`);
		}
		raw = match[1];
	}

	// Strip dashes to get pure hex
	const hex = raw.replace(/-/g, "");

	if (!/^[a-f0-9]{32}$/i.test(hex)) {
		throw new Error(`Invalid Notion ID: ${input}`);
	}

	// Format as UUID: 8-4-4-4-12
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20, 32),
	].join("-");
}
