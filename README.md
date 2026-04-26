# Stonerelay

adversary's pull-path tool for Notion → Obsidian sync.

**Forked from [ran-codes/obsidian-notion-database-sync](https://github.com/ran-codes/obsidian-notion-database-sync)**, MIT licensed. Extending with [planned: bidirectional sync, custom property mappings, etc.].

---

*Original README below.*

# Notion Database Sync

Sync Notion databases and pages into your Obsidian vault as Markdown files.

## Features

- **Sync individual pages** — Import any Notion page as a Markdown file with YAML frontmatter.
- **Sync entire databases** — Pull all entries from a Notion database into a folder, with an Obsidian Base file for table view.
- **Incremental updates** — Re-sync only fetches pages that have changed since the last sync.
- **Deletion tracking** — Entries removed from Notion are flagged with `notion-deleted: true` in frontmatter rather than deleted locally.
- **Property mapping** — Notion database properties (text, number, select, multi-select, date, checkbox, URL, etc.) are converted to YAML frontmatter fields.
- **Block conversion** — Notion headings h1-h6 are converted to Markdown heading syntax.

## Setup

1. Create a Notion integration at [notion.so/profile/integrations](https://notion.so/profile/integrations) and copy the API key.
2. Share the Notion pages or databases you want to sync with your integration.
3. In Obsidian, go to **Settings > Community plugins > Notion Database Sync**.
4. Paste your API key into the **Notion API key** field.
5. Optionally change the **Default output folder** (defaults to `Notion`).

## Usage

### Sync a page or database

1. Open the command palette and run **Sync Notion page or database**, or click the ribbon icon.
2. Paste a Notion URL, UUID, or 32-character ID.
3. Choose an output folder and click **Sync**.

### Re-sync

- **Database**: Open the sync modal and click **Re-sync** next to a previously synced database.
- **Single page**: Open a synced page and run **Re-sync this page** from the command palette.

## Output structure

Single page:
```
Notion/
  Page Title.md
```

Database:
```
Notion/
  Database Name/
    Database Name.base
    Entry 1.md
    Entry 2.md
```

Each synced file includes frontmatter with `notion-id`, `notion-url`, `notion-frozen-at`, and `notion-last-edited` for tracking.

## Timestamp preservation

Stonerelay preserves user-set Notion date properties through Notion → vault → Notion round-trips. Date-only values, date ranges, datetime strings, empty dates, and date objects with `time_zone` are serialized back to the Notion date payload shape.

Notion-managed `Created time` is preserved when a push updates the original row matched by `notion-id`. If a frontmatter `notion-id` no longer exists in the target database, stonerelay emits a warning and skips that file instead of silently creating a duplicate row with a new Created time.

Notion-managed `Last edited time` is not preservable. Notion updates it on every successful page update, so pushes should be expected to bump that timestamp.

## Two-phase sync

Stonerelay uses a two-phase configuration model for database sync direction.

Phase 1 = initial seed (declare canonicality). New database entries must start with Pull or Push so the initial source is explicit. Pull means Notion is canonical for the first seed into the vault. Push means Obsidian is canonical for the first seed into Notion. Bidirectional is locked until the first full sync completes cleanly.

Phase 2 = steady-state partnership (with conflict resolution). After a clean first sync, entries can switch to Bidirectional and choose `source_of_truth`: Notion wins, Obsidian wins, or manual merge. Manual merge stores conflicts with snapshots and opens a resolution view so rows are not auto-resolved.

Sync safety behavior:

- Per-row failures follow the rsync pattern: one failed row records `lastSyncStatus: partial` and `lastSyncErrors`, then later rows continue.
- Cancellation uses an in-memory AbortController. Cancel stops at the next row boundary, writes final sync state once, and preserves partial work.
- `data.json` writes use temp-file plus rename semantics to avoid partial config writes.
- Each database can either nest files under `<DB-name>/` or sync flat into its configured vault folder.

## License

[MIT](LICENSE)
