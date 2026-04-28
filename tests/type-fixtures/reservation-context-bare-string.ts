import type { SyncRunOptions } from "../../src/types";

const invalidOptions: SyncRunOptions = {
	context: "bare-string",
};

void invalidOptions;
