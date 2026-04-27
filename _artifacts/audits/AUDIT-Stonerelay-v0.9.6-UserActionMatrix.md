# Stonerelay v0.9.6 User-Action Interaction Matrix

Source: `src/action-audit.ts`

| # | Action | Effect | Folder helper | Safety gate |
|---|---|---|---|---|
| 1 | Add database | vault-write | `resolveDatabasePathModel` | `validateVaultFolderPath` |
| 2 | Edit database | vault-write | `resolveDatabasePathModel` | `validateVaultFolderPath` |
| 3 | Remove database from sync list | vault-write | `resolveDatabasePathModel` | settings update only |
| 4 | Create, rename, collapse, expand, or delete group | vault-write | `groupedSyncEntries` | settings update only |
| 5 | Save global settings | vault-write | `resolveConfiguredParentFolder` / `resolveErrorLogFolder` | `validateVaultFolderPath` |
| 6 | Test connection / auto-fill database metadata | read-only | `resolveDatabasePathModel` | Notion read-only metadata request |
| 7 | Pull one database | vault-write | `resolveDatabasePathModel` | `evaluatePullSafety` |
| 8 | Push one database | Notion-write | `resolveDatabasePathModel` | `evaluatePushSafety` |
| 9 | Sync all enabled databases | both | `resolveDatabasePathModel` | `evaluatePullSafety` / `evaluatePushSafety` per entry |
| 10 | Push all enabled databases | Notion-write | `resolveDatabasePathModel` | `evaluatePushSafety` |
| 11 | Retry failed rows | both | `resolveDatabasePathModel` | `evaluatePullSafety` / `evaluatePushSafety` by original direction |
| 12 | Import standalone page | vault-write | `resolvePagePathModel` | `validateVaultFolderPath` |
| 13 | Refresh standalone page | vault-write | `resolvePagePathModel` | exact page file routing |
| 14 | Page auto-sync refresh | vault-write | `resolvePagePathModel` | `isAutoSyncEligible` + exact `lastFilePath` match |
| 15 | Database auto-sync candidate detection | read-only | `resolveDatabasePathModel` | `findAutoSyncEntryForPath` |
| 16 | Database auto-sync execution if it is ever re-enabled | Notion-write | `resolveDatabasePathModel` | `isAutoSyncEligible` + `evaluatePushSafety` |
| 17 | Cancel one sync | vault-write | active sync entry id | AbortController row-boundary cancellation |
| 18 | Cancel all syncs | vault-write | active sync entry ids | AbortController row-boundary cancellation |
| 19 | Apply conflict resolution: Keep Notion | vault-write | `resolveDatabasePathModel` | `evaluatePullSafety` |
| 20 | Apply conflict resolution: Keep Vault | Notion-write | `resolveDatabasePathModel` | `evaluatePushSafety` |
| 21 | Apply conflict resolution: Skip | vault-write | conflict row id | `resolveManualMergeConflict` |
| 22 | Startup interrupted-sync recovery | vault-write | configured entry ids | `writePluginDataAtomic` |
| 23 | Error-log writing | vault-write | `resolveErrorLogFolder` | `validateVaultFolderPath` + atomic temp write |
| 24 | Base-file generation/update | vault-write | `resolveDatabasePathModel` | user-edited `.base` preservation |

Notes:
- Database auto-sync execution remains disabled in v0.9.6. Candidate detection is read-only and uses resolved database content folders.
- Push and Push All share `evaluatePushSafety`; conflict Keep Vault also enters that gate before Notion writes.
- Pull retry IDs remain Notion row IDs. Push retry IDs remain vault file paths inside the resolved push source folder.
