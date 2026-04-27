# adversary changes

Fork-side changes to `stonerelay` (vs. upstream `ran-codes/obsidian-notion-database-sync`).

## v0.9.0 — 2026-04-27

Adds organized active-work sync surfaces with groups, standalone page entries, and safe auto-sync queueing.

**Behavior notes:**
- Settings data migrates to schema 5 with collapsible groups, standalone page entries, and global database/page auto-sync defaults.
- Database and page rows can be assigned to groups, carry per-entry `Inherit / On / Off` auto-sync overrides, and keep manual Pull, Push, Refresh, Retry, Cancel, and conflict actions available.
- Standalone page import accepts Notion page URLs or IDs, writes Markdown through the existing block conversion path, and refreshes only the configured page file.
- Background vault events are watched only through the plugin runtime, debounced into a queue, collapsed by entry/path, and blocked by active syncs, pending conflicts, or partial/error/cancelled/interrupted statuses.
- Background both-side-changed detection halts and persists pending conflict snapshots before any write-back; conflict resolution still requires explicit user action.
- Error-log routing now covers page entries and auto-sync runs, with token redaction preserved.

## v0.8.1 — 2026-04-27

Polishes pegged-database settings UX and hardens plugin data persistence semantics.

**Behavior notes:**
- Bidirectional rows now present as `Pegged`, with header counts for pegged, pull-only, and push-only databases.
- Row actions use clearer Pull/Push labels, icon-only Edit/Delete controls, and the database name carries the Notion-open affordance.
- Sync history tooltips use persisted sync fields only; future auto-sync readiness is surfaced without enabling background writes.
- Global and per-database error-log folders route partial, error, and conflict logs when configured.
- `writePluginDataAtomic` documents its temp-first rename/fallback contract and keeps startup interrupted-sync persistence non-fatal.
- Force resync and full file-watcher auto-sync remain deferred because the v0.8.1 base spec excludes a new sync algorithm and background polling.

## v0.7.7 — 2026-04-26

Fixes noisy retry loops when Obsidian rejects plugin `data.json` rename-over-existing and a Notion row contains an inaccessible nested child block.

**Behavior notes:**
- The confirmed write-confirm-remove fallback remains in place for `data.json`, but the expected existing-destination adapter behavior no longer logs a warning on every settings save.
- Unexpected adapter rename failures still warn before using the fallback path.
- Nested Notion child blocks that return `object_not_found` are skipped with a markdown comment so the parent row can still refresh.
- Top-level Notion page or database access failures still fail the row, preserving the sharing/permissions signal.

## v0.7.6 — 2026-04-26

Fixes pull failures for Notion rows whose titles are too long to use directly as vault filenames.

**Behavior notes:**
- Normal-length titles keep their existing sanitized filenames.
- Overlong titles are truncated to a safe UTF-8 byte length and receive a short Notion page-id suffix to avoid collisions.
- The full Notion row title remains available from the row content/properties; only the vault filename is shortened.

## v0.7.5 — 2026-04-26

Restores Notion-title auto-fill for new database entries after pasting a Notion URL or ID.

**Behavior notes:**
- New entries still initialize safely as `Untitled database`.
- If the Name field has not been edited, fetched Notion metadata replaces the default label with the database title.
- User-entered custom names are preserved and are not overwritten by metadata refreshes.

## v0.7.4 — 2026-04-26

Hardens startup recovery so interrupted-sync bookkeeping cannot abort plugin load if settings persistence fails.

**Behavior notes:**
- Startup still marks interrupted syncs in memory and attempts to persist that recovery state.
- If persistence fails, Stonerelay logs the failure and continues loading commands, ribbon UI, and settings UI.
- The user still receives the interrupted-sync notice so the recovery state remains visible.

## v0.7.3 — 2026-04-26

Fixes the confirmed Obsidian reload failure where the adapter throws `Destination file already exists!` when replacing plugin `data.json`.

**Behavior notes:**
- Keeps the temp-write-first path.
- If `rename(temp, data.json)` fails, verifies the temp payload and overwrites `data.json` through the adapter write path.
- Removes the temp file after the confirmed overwrite fallback.

## v0.7.2 — 2026-04-26

Fixes plugin reload when Obsidian's adapter exposes temp writes and rename, but refuses to rename a temp `data.json` over the existing plugin data file.

**Behavior notes:**
- Startup recovery still writes the new settings payload to a temp file first.
- If the adapter cannot replace the existing `data.json` directly, Stonerelay moves the old file to a temporary backup, renames the temp file into place, then removes the backup.
- If replacement fails after backup, Stonerelay attempts to restore the prior `data.json` before surfacing the original load error.

## v0.7.1 — 2026-04-25

Fixes plugin load on Obsidian adapter surfaces that do not expose the direct temp-write API used by the v0.7.0 atomic settings path.

**Behavior notes:**
- Atomic `data.json` writes still use adapter temp write + rename when available.
- Rename-less adapters use the v0.7.0 write-confirm-remove fallback.
- If the adapter does not expose direct write, Stonerelay logs a warning and falls back to Obsidian's `Plugin.saveData()` instead of failing plugin load.

## v0.7.0 — 2026-04-25

Adds two-phase configuration for safe source-of-truth bidirectional sync.

**Two-phase behavior:**

| Area | Change |
|---|---|
| Phase 1 | New database entries start as initial seed configs and require Pull or Push canonicality |
| Phase 2 | A clean first sync unlocks Bidirectional plus `source_of_truth` selection |
| Source of truth | Supports Notion wins, Obsidian wins, and manual merge for conflict handling |
| Conflict storage | Manual merge stores row snapshots in `pendingConflicts` and opens a minimal resolution view |
| Schema migration | Bumps `schemaVersion` to 4; migrated synced entries become Phase 2, unsynced entries remain Phase 1 |

**Safety behavior:**

| Area | Change |
|---|---|
| Cancellation | In-flight syncs use AbortController and exit at row boundaries |
| Cancel All | Cancels every active in-memory controller; sync workers write their own final state |
| Per-row failures | A failed row records `lastSyncErrors` and continues later rows; final status is `partial` |
| Resume cursor | `lastCommittedRowId` records the last successful row commit for cancellation/interruption recovery |
| Atomic config writes | `data.json` writes now use temp-file plus rename semantics where the Obsidian adapter exposes write/rename |
| Folder layout | Per-database `nest_under_db_name` controls nested vs flat vault output |

**Behavior notes:**
- Phase 1 transitions to Phase 2 only when a full sync ends with `lastSyncStatus: "ok"` and zero row errors.
- Cancelled, partial, errored, interrupted, and retry-only runs stay in Phase 1.
- Existing v0.6 entries keep their prior behavior through migration defaults: nested folders, no active sync id, empty row-error list, and derived source-of-truth.
- Live Notion validation was not run; test coverage uses local Vitest harnesses and mocked Notion API responses.

## v0.6.5 — 2026-04-25

Adds pull-side block conversion for leaked Notion `heading_4`, `heading_5`, and `heading_6` blocks.

**Heading block behavior:**

| Area | Change |
|---|---|
| `heading_4` | Converts to `####` Markdown instead of being dropped as unsupported |
| `heading_5` | Converts to `#####` Markdown instead of being dropped as unsupported |
| `heading_6` | Converts to `######` Markdown instead of being dropped as unsupported |
| Existing headings | Keeps `heading_1`, `heading_2`, and `heading_3` conversion behavior intact |
| Rich text | Preserves existing rich-text concatenation and annotation rendering through the shared converter |

**Behavior notes:**
- Pull-side only: push handling for h4/h5/h6 remains out of scope because Notion's public block API only accepts h1-h3.
- Unsupported-block warnings remain for genuinely unhandled block types, but no longer fire for h4/h5/h6.

## v0.6.4 — 2026-04-25

Fixes the v0.6.3 form layout so the new direction copy and preview controls are visible at modal width.

**Form layout behavior:**

| Area | Change |
|---|---|
| Sync direction section | Restores a visible `Sync direction` heading with direction consequence helper text |
| Direction options | Stacks Pull, Push, and Bidirectional vertically so verbose labels do not clip |
| Direction caveat | Renders the v0.6 last-writer-wins warning immediately under the radio stack |
| Preview area | Shows an inactive Test connection placeholder before the first click |
| Preview rows | Renders connection, vault count, and next-sync action as distinct rows below Test connection |
| Vault folder helper | Keeps the v0.6.3 direction-aware helper text wired to radio changes |

**Behavior notes:**
- Layout-only release: no schema changes and no changes to sync execution logic.
- Forbidden sync-related files remained untouched.

## v0.6.3 — 2026-04-25

Polishes the Add/Edit Database form so sync direction consequences are visible before saving.

**Form UX behavior:**

| Area | Change |
|---|---|
| Direction labels | Replaces terse Pull/Push/Bidirectional labels with source-and-seeding consequence copy |
| Bidirectional caveat | Calls out v0.6 last-writer-wins behavior until v0.7 conflict handling ships |
| Vault folder | Renames Output folder to Vault folder and pivots helper text by selected direction |
| Test connection | Adds a preview with Notion row/property counts, vault markdown count, and direction-aware next-sync action |
| Empty source warnings | Shows non-blocking warnings for Push from an empty vault folder and Pull from an empty Notion database |
| Edit safety | Confirms direction changes for entries that have already synced |

**Behavior notes:**
- UX-only release: no schema changes and no changes to sync execution logic in `src/push.ts` or `src/database-freezer.ts`.
- Bidirectional remains selectable in v0.6.3 to preserve existing behavior; v0.7 owns the deeper source-of-truth model.

## v0.6.2 — 2026-04-25

Preserves timestamp integrity through Obsidian → Notion push round-trips.

**Timestamp behavior:**

| Area | Change |
|---|---|
| User-set dates | Serializes date-only values, date ranges, datetime strings, empty dates, and date objects with `time_zone` back into Notion date payloads |
| Created time | Keeps Notion-managed Created time intact by updating rows matched by `notion-id` |
| Last edited time | Documents Notion's expected Last edited time bump on every successful update |
| Stale notion-id | Skips rows whose frontmatter `notion-id` is absent from the target database, with a warning, instead of silently creating duplicates |
| New rows | Refreshes frontmatter `notion-id` after successful create/update responses so later pushes target the same row |

**Audit notes:**
- Created the live "Stonerelay Timestamp Test" fixture under a Notion test database and captured `tests/fixtures/timestamp-baseline.json`.
- Local test coverage passes for the six timestamp classes in `tests/timestamp-preservation.test.ts`.
- Live stonerelay pull/push comparison was blocked in Codex by missing local Notion API credentials; the Notion connector could create and inspect the fixture but cannot run the plugin's API-key-backed sync path.

## v0.6.0 — 2026-04-25

Adds Obsidian → Notion push integration for frontmatter properties.

**New push behavior:**

| Area | Change |
|---|---|
| Direction config | Per-database `direction` supports `pull`, `push`, and `bidirectional`; existing entries migrate to `pull` under schema version 3 |
| Push commands | Adds `Stonerelay: Push all enabled databases` and `Stonerelay: Push one database` |
| Row actions | Push or bidirectional rows show a direction icon plus `Push now` |
| Upsert semantics | Matches by `notion-id` first, then title, and updates existing Notion pages in place |
| New rows | Markdown files without a matching Notion row create pages in the configured database |
| Property handlers | Pushes title, rich text, number, select, multi-select, status, date, checkbox, URL, email, phone, and relation properties |
| Rate limits | Reuses the existing 340ms throttle and 5-retry Notion request wrapper |

**Behavior notes:**
- v0.6 push syncs frontmatter properties only. Markdown body → Notion blocks is deferred to v0.7.
- Deletes are intentionally not propagated from Obsidian to Notion.
- Status properties use Notion's `{ status: { name } }` payload shape, not select payloads.
- Rich text is chunked at 1900 chars on safe boundaries.
- The standalone external push script workflow has been folded into `src/push.ts`; the script is now marked deprecated as historical reference.
- Version is plain `0.6.0` for BRAT compatibility.

## v0.5.0 — 2026-04-25

Adds auto-inferred default views for generated Obsidian `.base` files.

**New `.base` behavior:**

| Area | Change |
|---|---|
| Date views | Detects date-like properties and adds a `Recent` table sorted descending |
| Open views | Detects status/resolved/done-style properties and adds `Open`, `Unresolved`, or `Active` views |
| Category views | Detects select/multi-select severity/priority/category-style properties and adds grouped `By <Category>` views |
| Minimal fallback | Databases without inferable properties still get the v0.4-compatible single `All entries` table |
| User edits | Existing `.base` files newer than the last configured sync are preserved instead of overwritten |

**Behavior notes:**
- View inference uses the Notion data source schema plus the first 10 pulled rows.
- Generated views are ordered most-useful first: `Recent`, open/unresolved, grouped category, then `All entries`.
- Version is plain `0.5.0` for BRAT upgrade compatibility from `0.4.0-adv`.

## v0.4.0-adv — 2026-04-25

Polishes the persisted database settings flow so users can paste a Notion URL or ID, fetch metadata, review the auto-filled label/folder, and save.

**New settings UX behavior:**

| Area | Change |
|---|---|
| Add/edit card | Replaces manual database ID entry with `Notion URL or ID *`, inline fetch status, metadata preview, and contained card styling |
| Auto-fill | Fetches Notion title/property/row metadata, fills Name, and defaults Output folder to `_relay/<slug>/` |
| Validation | Accepts Notion URLs plus dashed or undashed IDs, trims API keys on paste/blur, and rejects output-folder traversal |
| Row actions | Moves Enabled to the static row, adds per-row `Sync now`, `Open in Notion`, and expandable sync-error detail |
| Helper text | Adds label descriptions, friendly empty state, API-key notice, and footer-aligned Save/Cancel buttons |

**Behavior notes:**
- Existing v0.3.0-adv persisted database entries migrate and render in the new row UI without data loss.
- Sync All and Sync One commands continue to use the existing v0.3.0 sync path.
- Row counts in the metadata preview are estimated from the first 100 Notion query results and display `100+` when more rows exist.

## v0.3.0-adv — 2026-04-25

Adds a persisted Notion database list and batch sync flow.

**New settings/data behavior:**

| Area | Change |
|---|---|
| `data.json` | Migrates to `schemaVersion: 2` with a `databases` array while preserving existing API key and default folder |
| Settings tab | Adds `Synced databases` with add/edit/delete, enabled toggles, and last-sync status |
| Commands | Adds `Stonerelay: Sync all enabled databases` and `Stonerelay: Sync one database` |
| Sync status | Stores `lastSyncedAt`, `lastSyncStatus`, and truncated error text per configured DB |

**Behavior notes:**
- Sync All runs enabled entries sequentially and continues past per-database errors.
- Per-database output folders fall back to the default output folder, then `_relay`.
- The original modal-driven one-off sync command remains available.

**Migration notes:**
- Existing v0.2.0-adv installs upgrade non-destructively: `apiKey` and `defaultOutputFolder` are preserved, `databases` starts empty, and `schemaVersion` becomes `2`.

## v0.2.0-adv — 2026-04-24

Adds 6 missing property type handlers identified by an internal coverage audit. Live pulls in v0.1.0-adv silently dropped these — most critically `unique_id` (auto-ID columns like `unique_id` prefixes) and `formula` (a date-formula property).

**New handlers in `src/page-writer.ts` (`mapPropertiesToFrontmatter`):**

| Type | Frontmatter shape |
|---|---|
| `unique_id` | Combined string `"BUG-57"` (or just number if no prefix); `null` if empty |
| `formula` | Inner-type-aware: string/number/boolean scalar; date as ISO string (or `start → end` for ranges) |
| `rollup` | Inner-type-aware: number/date as scalars; array as YAML list of simplified items |
| `verification` | `state` only (`"verified"` / `"unverified"`); metadata (verified_by, date) discarded |
| `created_by` | User `name` if present, else `id` |
| `last_edited_by` | User `name` if present, else `id` |

**Behavior notes:**
- Rollup arrays are simplified per inner type (titles/rich_text → string, select → name, relation → id). Unknown inner types JSON-encode as fallback.
- All new handlers return `null` for missing/empty values rather than throwing or omitting the key.
- Additive only — v0.1.0-adv handlers untouched.

**Known limitations (deferred to v0.3+):**
- `verification` does not emit `verified_by` user or verification date — state only.
- `button` property type still skipped (no user-facing value to emit).
- Relation properties still emit bare UUIDs (display-name resolution = v0.3+).
- No persisted DB list in `data.json` (modal-driven sync only) — v0.3+.

## v0.1.0-adv — 2026-04-24

Fork baseline. No code changes yet.

- `manifest.json`: id → `stonerelay`, name → `Stonerelay`, version → `0.1.0-adv`, author + authorUrl rebranded, description appended with fork attribution.
- `README.md`: fork-attribution header added; original content preserved below.
- `LICENSE`: untouched (MIT).

## Planned

- [ ] Bidirectional sync — pair with standalone `notion-push.js` (adversary push path) for full round-trip.
- [ ] Custom property mappings — declarative config for Notion property → Obsidian frontmatter key transforms.
- [ ] Obsidian-native pull patterns — match adversary's vault structure (folder layout, naming conventions).
- [ ] Settings UI extension — surface adversary-specific config without breaking upstream merge compatibility.
- [ ] Upstream sync strategy — track ran-codes/main; rebase fork changes on top, not merge.
