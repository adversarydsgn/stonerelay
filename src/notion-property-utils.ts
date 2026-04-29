export function extractUniqueId(properties: unknown): string | null {
	if (!properties || typeof properties !== "object") return null;
	const source = properties as Record<string, unknown>;
	const candidates = isUniqueIdProperty(source) ? [source] : Object.values(source);
	for (const candidate of candidates) {
		if (!candidate || typeof candidate !== "object") continue;
		const prop = candidate as { type?: unknown; unique_id?: { prefix?: unknown; number?: unknown } | null };
		if (prop.type !== "unique_id") continue;
		const uid = prop.unique_id;
		if (!uid || typeof uid.number !== "number") return null;
		const prefix = typeof uid.prefix === "string" && uid.prefix ? uid.prefix : null;
		return prefix ? `${prefix}-${uid.number}` : String(uid.number);
	}
	return null;
}

function isUniqueIdProperty(value: Record<string, unknown>): boolean {
	return value.type === "unique_id";
}
