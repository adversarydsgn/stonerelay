export class TFile {
	path = "";
	name = "";
	basename = "";
	extension = "";
}

export class TFolder {
	path = "";
	children: unknown[] = [];
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

export async function requestUrl(): Promise<never> {
	throw new Error("requestUrl is not available in tests");
}
