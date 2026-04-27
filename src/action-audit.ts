export type UserActionEffect = "read-only" | "vault-write" | "Notion-write" | "both";

export interface UserActionAuditRow {
	action: string;
	effect: UserActionEffect;
	pathHelper: string;
	safetyGate: string;
	notes: string;
}

export const USER_ACTION_AUDIT: UserActionAuditRow[] = [
	{ action: "Add database", effect: "vault-write", pathHelper: "resolveDatabasePathModel", safetyGate: "validateVaultFolderPath", notes: "Writes plugin settings only." },
	{ action: "Edit database", effect: "vault-write", pathHelper: "resolveDatabasePathModel", safetyGate: "validateVaultFolderPath", notes: "Writes plugin settings only; direction changes require confirmation." },
	{ action: "Remove database from sync list", effect: "vault-write", pathHelper: "resolveDatabasePathModel", safetyGate: "settings update only", notes: "Does not delete synced Markdown or Notion rows." },
	{ action: "Create, rename, collapse, expand, or delete group", effect: "vault-write", pathHelper: "groupedSyncEntries", safetyGate: "settings update only", notes: "Group changes affect plugin settings only." },
	{ action: "Save global settings", effect: "vault-write", pathHelper: "resolveConfiguredParentFolder / resolveErrorLogFolder", safetyGate: "validateVaultFolderPath", notes: "Persists data.json through atomic plugin-data writer." },
	{ action: "Test connection / auto-fill database metadata", effect: "read-only", pathHelper: "resolveDatabasePathModel", safetyGate: "Notion read-only metadata request", notes: "Reads Notion metadata and local vault counts only." },
	{ action: "Pull one database", effect: "vault-write", pathHelper: "resolveDatabasePathModel", safetyGate: "evaluatePullSafety", notes: "Reads Notion and writes only the resolved pull target folder." },
	{ action: "Push one database", effect: "Notion-write", pathHelper: "resolveDatabasePathModel", safetyGate: "evaluatePushSafety", notes: "Scans only the resolved push source folder before writing Notion rows." },
	{ action: "Sync all enabled databases", effect: "both", pathHelper: "resolveDatabasePathModel", safetyGate: "evaluatePullSafety / evaluatePushSafety per entry", notes: "Sequential per-database execution; no shared broad push source." },
	{ action: "Push all enabled databases", effect: "Notion-write", pathHelper: "resolveDatabasePathModel", safetyGate: "evaluatePushSafety", notes: "Uses the same push gate as manual Push." },
	{ action: "Retry failed rows", effect: "both", pathHelper: "resolveDatabasePathModel", safetyGate: "evaluatePullSafety / evaluatePushSafety by original direction", notes: "Pull retries use row IDs; push retries use vault paths inside the source folder." },
	{ action: "Import standalone page", effect: "vault-write", pathHelper: "resolvePagePathModel", safetyGate: "validateVaultFolderPath", notes: "Writes one standalone page file and plugin settings." },
	{ action: "Refresh standalone page", effect: "vault-write", pathHelper: "resolvePagePathModel", safetyGate: "exact page file routing", notes: "Writes only the configured standalone page file." },
	{ action: "Page auto-sync refresh", effect: "vault-write", pathHelper: "resolvePagePathModel", safetyGate: "isAutoSyncEligible + exact lastFilePath match", notes: "Exact known file path is preferred before broad page folder matching." },
	{ action: "Database auto-sync candidate detection", effect: "read-only", pathHelper: "resolveDatabasePathModel", safetyGate: "findAutoSyncEntryForPath", notes: "Detection uses resolved content folders and must route to one database only." },
	{ action: "Database auto-sync execution if it is ever re-enabled", effect: "Notion-write", pathHelper: "resolveDatabasePathModel", safetyGate: "isAutoSyncEligible + evaluatePushSafety", notes: "Execution remains disabled until file-scoped push exists." },
	{ action: "Cancel one sync", effect: "vault-write", pathHelper: "active sync entry id", safetyGate: "AbortController row-boundary cancellation", notes: "Writes final sync status only when worker settles." },
	{ action: "Cancel all syncs", effect: "vault-write", pathHelper: "active sync entry ids", safetyGate: "AbortController row-boundary cancellation", notes: "Cancels active workers and updates persisted status." },
	{ action: "Apply conflict resolution: Keep Notion", effect: "vault-write", pathHelper: "resolveDatabasePathModel", safetyGate: "evaluatePullSafety", notes: "Routes through pull retry before writing the vault." },
	{ action: "Apply conflict resolution: Keep Vault", effect: "Notion-write", pathHelper: "resolveDatabasePathModel", safetyGate: "evaluatePushSafety", notes: "Routes through push retry before writing Notion." },
	{ action: "Apply conflict resolution: Skip", effect: "vault-write", pathHelper: "conflict row id", safetyGate: "resolveManualMergeConflict", notes: "Only updates pending conflict state." },
	{ action: "Startup interrupted-sync recovery", effect: "vault-write", pathHelper: "configured entry ids", safetyGate: "writePluginDataAtomic", notes: "Persists recovery state without running sync jobs." },
	{ action: "Error-log writing", effect: "vault-write", pathHelper: "resolveErrorLogFolder", safetyGate: "validateVaultFolderPath + atomic temp write", notes: "Writes sanitized logs only to the resolved log folder." },
	{ action: "Base-file generation/update", effect: "vault-write", pathHelper: "resolveDatabasePathModel", safetyGate: "user-edited .base preservation", notes: "Writes inside the pull target folder and preserves newer user edits." },
];
