# adversary changes

Fork-side changes to `stonerelay` (vs. upstream `ran-codes/obsidian-notion-database-sync`).

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
- Created the live "Stonerelay Timestamp Test" fixture under Notion Testing Ground and captured `tests/fixtures/timestamp-baseline.json`.
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
- The standalone `~/Desktop/_inbox/notion-push.js` workflow has been folded into `src/push.ts`; the script is now marked deprecated as historical reference.
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

Adds 6 missing property type handlers identified by Agent U's v0.1.0-adv coverage audit. Live pulls in v0.1.0-adv silently dropped these — most critically `unique_id` (BUG-NN, FRIC-NN, SEC-NN auto-IDs) and `formula` (Power 150's `Contact Next`).

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
