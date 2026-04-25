# Stonerelay

Adversary's pull-path tool for Notion → Obsidian sync.

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

## License

[MIT](LICENSE)
