# Adversary Changes

Fork-side changes to `stonerelay` (vs. upstream `ran-codes/obsidian-notion-database-sync`).

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

- [ ] Bidirectional sync — pair with standalone `notion-push.js` (Adversary push path) for full round-trip.
- [ ] Custom property mappings — declarative config for Notion property → Obsidian frontmatter key transforms.
- [ ] Obsidian-native pull patterns — match Adversary's vault structure (folder layout, naming conventions).
- [ ] Settings UI extension — surface Adversary-specific config without breaking upstream merge compatibility.
- [ ] Upstream sync strategy — track ran-codes/main; rebase fork changes on top, not merge.
