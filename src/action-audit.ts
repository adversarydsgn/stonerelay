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
	{ action: "Reservation acquired", effect: "read-only", pathHelper: "resolveDatabasePathModel", safetyGate: "ReservationManager combo lock", notes: "Records an active operation before Notion or vault writes begin." },
	{ action: "Reservation released", effect: "read-only", pathHelper: "active reservation id", safetyGate: "ReservationManager release", notes: "Clears active operation state after the worker settles." },
	{ action: "Reservation rejected (key conflict)", effect: "read-only", pathHelper: "Notion database id + resolved folder", safetyGate: "ReservationManager combo lock", notes: "Manual operations fail fast when DB or folder is busy." },
	{ action: "Reservation queued (batch op)", effect: "read-only", pathHelper: "Notion database id + resolved folder", safetyGate: "ReservationManager queue depth", notes: "Batch operations queue per entry up to the configured depth." },
	{ action: "Push intent recorded", effect: "vault-write", pathHelper: "push-intents.jsonl", safetyGate: "atomic temp write", notes: "Records create-before-frontmatter phases for crash recovery." },
	{ action: "Push intent recovered (startup)", effect: "vault-write", pathHelper: "push-intents.jsonl", safetyGate: "startup recovery scan", notes: "Surfaces created-but-uncommitted push intents for operator recovery." },
	{ action: "Atomic write committed", effect: "vault-write", pathHelper: "atomic-vault-write", safetyGate: "temp write + rename or verified fallback", notes: "All vault content writes route through the atomic helper." },
	{ action: "Vault canonical mirror written (Push create)", effect: "Notion-write", pathHelper: "canonical_id_property", safetyGate: "canonical_id_property configured + vault ID present", notes: "Shifted from requested action 32 because existing audit rows occupied 32-38." },
	{ action: "Vault canonical mirror written (Push update)", effect: "Notion-write", pathHelper: "canonical_id_property", safetyGate: "canonical_id_property configured + vault ID present", notes: "Vault ID is canonical; Notion mirror is overwritten when configured." },
	{ action: "Vault canonical mirror divergence detected", effect: "read-only", pathHelper: "canonical_id_property", safetyGate: "conflict snapshot before vault-wins mirror update", notes: "Surfaces operator-visible conflict while preserving vault-wins default for the mirror." },
	{ action: "Notion-only row materialized awaiting ID stamp", effect: "vault-write", pathHelper: "resolveDatabasePathModel", safetyGate: "canonical_id_property configured + empty mirror", notes: "Stonerelay does not claim or increment .next-id." },
	{ action: "Notion-only row materialized with mirror ID adopted", effect: "vault-write", pathHelper: "resolveDatabasePathModel", safetyGate: "canonical_id_property configured + populated mirror", notes: "Adopts the Notion-side mirror into vault ID frontmatter without touching .next-id." },
	{ action: "Vault canonical sequence-lag warning surfaced", effect: "read-only", pathHelper: ".next-id", safetyGate: "read-only bare-integer parse", notes: "Warns when observed Notion unique_id max is greater than or equal to vault .next-id." },
	{ action: "Vault canonical lockfile read", effect: "read-only", pathHelper: ".next-id / .next-id.lock", safetyGate: "read-only diagnostics", notes: "Reads lockfile status for diagnostics without acquiring or modifying the lock sentinel." },
];
