# SPEC — Stonerelay v0.9.7: Lifecycle Unification + Safety Symmetry + Atomic Writes

**Status:** being-planned
**Drafted:** 2026-04-27 (SES-383)
**Author:** Claude (post-chaos-audit synthesis)
**Project version:** v0.1
**Working repo:** `/Users/adversary/Desktop/Projects/stonerelay`
**Prior version:** v0.9.6 (BUG-540 closed, diagnostics + BRAT panels + §16.4 threshold gate)
**Inputs:**
- `_artifacts/audits/AUDIT-Stonerelay-v0.9.6-ChaosFailureModes-20260427-234708Z.md` — 30-vector chaos audit, 8 Block findings
- `_artifacts/audits/AUDIT-Stonerelay-v0.9.6-UserActionMatrix.md` — 24-action surface inventory
- [DEC-450](https://www.notion.so/Stonerelay-v0-9-7-Block-floor-established-by-chaos-audit-35061ec214e6817c8abff7235fc3b1c7) — v0.9.7 Block-floor established (5 fix clusters)
- [DEC-451](https://www.notion.so/Stonerelay-v0-9-7-product-design-questions-four-locks-35061ec214e6816ba155d5ca4d9ec20c) — Four product-design locks (seed-mode toggle, stale-id remediation, BRAT deferred, combo lock)
- [LOOP-594](https://www.notion.so/Stonerelay-v0-9-7-spec-drafting-5-Block-clusters-product-design-opens-35061ec214e681c59890c9bdeebe0af5) — Spec drafting plan

**Target executor:** Codex 5.5

---

## Mission

The chaos audit found that v0.9.6 has correct happy paths and good Push-side safety gates, but eight Block-severity vulnerabilities reachable when the world goes sideways. Five fix clusters close them. v0.9.7 ships those five clusters plus two product-design surfaces (per-folder seed mode, stale-id remediation prompt). The Templater + multi-writer Notion track is gated on v0.9.7 shipping — multi-writer load stresses exactly the surfaces this spec hardens.

This is invasive surgery on the sync lifecycle. Apply the **1.2× time multiplier** from `~/.claude/skills/codex-handoff/SKILL.md` — the reservation primitive (cluster A) touches every writer in the codebase and rewrites the active-run model.

---

## Reference Files (read before editing)

Sequential read required. Do not edit until the call graph for each cluster is traced.

- `src/main.ts` — plugin entry, command registration, top-level action handlers (`syncOneConfiguredDatabase`, `pushOneConfiguredDatabase`, `syncAllEnabledDatabases`, `pushAllEnabledDatabases`, `beginSync`, `markInterruptedSyncs`, `cancelSync`)
- `src/auto-sync.ts` — auto-sync orchestration, AbortController plumbing
- `src/page-sync.ts` — per-row pull/push loop
- `src/page-writer.ts` — atomic-write hooks, `writeDatabaseEntry`
- `src/notion-client.ts` — API client wrapper, `notionRequest`, retry behavior
- `src/path-model.ts` — vault path resolution
- `src/sync-safety.ts` — `evaluatePullSafety`, `evaluatePushSafety`, overlap gate, `validatePushCandidateFiles`, threshold logic
- `src/sync-state.ts` — cursor + commit logic
- `src/conflict-resolution.ts` — conflict row handling
- `src/settings.ts` + `src/settings-data.ts` — migration + persistence + `migrateData`
- `src/plugin-data.ts` — `writePluginDataAtomic`, capability ladder, startup recovery
- `src/database-freezer.ts` — Pull row loop, `markAsDeleted`, deletion pass, local file scan
- `src/push.ts` — Push row loop, `byId` lookup, stale-id handling, `parseFrontmatter`, `validatePushCandidateFiles`
- `src/diagnostics-panel.ts` — UI surface; new states for reservations + remediation flows must surface here
- `src/action-audit.ts` — action enumeration; cluster A may add new internal actions
- `tests/` — match existing patterns (`obsidian-mock.ts`, fixtures, vitest)

---

## §1 — Cluster A: Sync Lifecycle Unification (V1 + V4 + V28)

### Problem

Three Block-severity findings collapse into one architectural fix:

- **V1** — Push preflight (`inspectStaleNotionIdSkips`) awaits Notion before `beginSync` installs the active controller. A Pull can begin during this window. When Push resumes, no re-check; same database has two writers.
- **V4** — Push creates a Notion page via `pages.create`, then writes the returned id to local frontmatter via `refreshFrontmatterNotionId`. If Obsidian crashes between those two steps, retry creates a duplicate Notion page (title-only fallback can miss).
- **V28 (NEW)** — `syncAllEnabledDatabases` and `pushAllEnabledDatabases` call `syncConfiguredDatabase` / `pushConfiguredDatabase` directly, bypassing `beginSync` entirely. Batch operations don't appear in `syncControllers`, can't be cancelled by `cancelSync`, and don't set `current_sync_id`. They're invisible to the active-run model.

### Fix — Reservation Primitive

> Amended in v0.9.9 to match implementation. See AUDIT-Stonerelay-v0.9.8-PostRelease and HANDOFF-Stonerelay-v0.9.9-AmendNotImplement.

Production entrypoints acquire `ReservationManager` handles. Exported writer helpers (`pushDatabase`, `freshDatabaseImport`, `refreshDatabase`, `writeDatabaseEntry`, `writeStandalonePage`, standalone page import) accept a caller-provided `reservationId` for orchestration. Helpers MAY be called with synthetic ids in unit tests, but production code paths MUST route through entrypoints that hold a real `ReservationManager` handle. Tests that pass synthetic ids must explicitly assert the amended boundary, not exercise it as production behavior.

**Reservation key (per [DEC-451](https://www.notion.so/Stonerelay-v0-9-7-product-design-questions-four-locks-35061ec214e6816ba155d5ca4d9ec20c) Q4 = combo lock):**

The lock keys against TWO surfaces simultaneously:
- **Notion DB id** — prevents two writers from racing the same Notion database
- **Resolved vault folder** — prevents two writers from racing the same vault directory (closes V5 collision surface for Pull as well)

A reservation must acquire both keys atomically. If either is held, the new operation queues or rejects per its policy.

### Reservation Lifecycle

```
acquire(dbId, vaultFolder, opType, signal) →
    if both keys free: install controller + cursor + emit reservation event
    if either held: rejected (manual ops) OR queued (batch ops, max queue depth: 3)

release(reservationId) →
    remove from registry
    persist commit log entry if push-create completed
    emit reservation-released event

cancel(reservationId) →
    fire AbortController
    wait for in-flight to settle (with timeout from cluster B / §3)
    release()
```

**Manual ops (Pull, Push, Retry, Conflict apply, Standalone page sync):** if reservation rejected, surface "DB X / Folder Y is busy with operation Z (started HH:MM)" — no auto-queue. Operator decides cancel-other or wait.

**Batch ops (Sync All, Push All):** can queue per-entry up to 3 deep. If queue full, batch operation aborts with operator notice listing un-queued entries.

**Auto-sync (database auto-sync re-enable, page auto-sync):** queues with depth 1. If queue full, skips silently to lastError state and surfaces in diagnostics.

### Push Crash-Resilient Commit (V4)

Add a **push intent log** at `<plugin-dir>/push-intents.jsonl` (atomic-temp+rename, append-mode-via-atomic-replace pattern from `plugin-data.ts`).

Each row write opens an intent record:
```json
{"intent_id": "<uuid>", "reservation_id": "<rid>", "vault_path": "<path>",
 "title_hash": "<sha256>", "phase": "creating", "started_at": "<iso>"}
```

After `pages.create` returns:
```json
{"intent_id": "<uuid>", "phase": "created", "notion_id": "<id>", "completed_at": "<iso>"}
```

After local frontmatter write commits:
```json
{"intent_id": "<uuid>", "phase": "committed", "completed_at": "<iso>"}
```

On startup, `markInterruptedSyncs` reads the intent log. Any intent stuck at `created` (created in Notion but local frontmatter not committed) surfaces a recovery action: "Push for `<vault_path>` created Notion page `<notion_id>` but did not write the id locally. Apply id now? Or delete the orphan Notion page?"

Intents older than 30 days that never reach `committed` are auto-archived (operator-visible) to prevent unbounded growth.

### Settings Migration

Add `data.json` schema field `active_reservations: []` (always empty on disk; runtime-only state). Bump schema version to 6.

### Action-Audit Updates

Add new internal actions to `action-audit.ts`:
- 25: Reservation acquired
- 26: Reservation released
- 27: Reservation rejected (key conflict)
- 28: Reservation queued (batch op)
- 29: Push intent recorded
- 30: Push intent recovered (startup)

These show up in the diagnostics panel's audit log.

### Acceptance Criteria

**A1.** Production entrypoints acquire `ReservationManager` handles before any awaited Notion call or vault write. Exported writer helpers (`pushDatabase`, `freshDatabaseImport`, `refreshDatabase`, `writeDatabaseEntry`, `writeStandalonePage`, standalone page import) accept a caller-provided `reservationId` for orchestration; helper-level unit tests may provide synthetic ids only when the test explicitly asserts that it is exercising the direct helper boundary rather than production entrypoint behavior.

**A2.** Concurrent Pull + Push on the same database id are serialized. Test (`reservation-same-db.test.ts`): start Push with mocked slow `inspectStaleNotionIdSkips`, attempt Pull during the wait — Pull rejected with "DB busy" message.

**A3.** Concurrent Pulls on overlapping vault folders (different DB ids, same folder ancestor) are serialized. Test (`reservation-folder-overlap.test.ts`): two databases with overlapping resolved folders, both attempt Pull — second rejected with "Folder busy" message.

**A4.** Sync All / Push All operations route through the reservation primitive. Test (`reservation-batch.test.ts`): Sync All on 3 entries with one entry busy (manual Pull mid-flight) — busy entry queues, others proceed.

**A5.** Cancel works against both manual and batch operations. Test (`cancel-batch.test.ts`): start Sync All, fire `cancelSync(reservationId)` for one queued entry — that entry skipped, others continue.

**A6.** Push intent log records create-before-frontmatter window. Test (`push-intent-crash.test.ts`): mock `pages.create` to resolve, throw before `refreshFrontmatterNotionId`, restart plugin — startup recovery surfaces the orphan with both options (apply locally / delete orphan in Notion).

**A7.** Push intent log persists atomically. Test (`push-intent-atomic.test.ts`): inject write failure mid-record — intent log either contains the complete record or no record at all, never a torn entry.

**A8.** Schema migration v5 → v6 idempotent and adds `active_reservations: []`. Test (`migration-v5-to-v6.test.ts`).

**A9.** Diagnostics panel surfaces active reservations with start time, type, and entry id. New "Active operations" section.

---

## §2 — Cluster B: Pull Safety Symmetry (V5)

### Problem

Push has overlap gates (`evaluatePushSafety` + `validatePushCandidateFiles`). Pull doesn't. Two databases mapped to overlapping resolved folders, when Pulled sequentially or concurrently, can mark each other's files as deleted because `database-freezer.ts` scans local files keyed only by `notion-id`. Database A's deletion pass sees B's row ids as "missing from A's current Notion query" and marks them deleted.

### Fix

**B1.** Apply `evaluatePushSafety`'s overlap detection logic to `evaluatePullSafety`. Reuse the helper; do not re-implement. Pull rejects with operator-visible reason: "Pull blocked: vault folder `<path>` overlaps with database `<other-db-name>` (configured at `<other-path>`)."

**B2.** Local file scan in `database-freezer.ts:scanLocalFiles` keys by **both** `notion-id` AND `notion-database-id`. Files whose `notion-database-id` doesn't match the current Pull's target are skipped during deletion-marking and diff comparison. Files lacking `notion-database-id` are treated as legacy and trigger a one-time backfill: when found during a Pull and the file's `notion-id` matches a row currently in this DB, the writer adds `notion-database-id: <current-db-id>` to frontmatter. Surface count of backfilled files in run summary.

**B3.** Sync All and fresh-import paths apply the overlap gate per-entry before starting each Pull.

**B4.** `validatePullCandidateFiles` (new helper) checks for: overlap, same-DB collision (two configured entries on the same Notion DB id — already a config error), and legacy frontmatter without `notion-database-id`.

### Acceptance Criteria

**B1.** Pull on a database whose resolved folder overlaps with another configured database's folder is rejected before any Notion query. Test (`pull-overlap-block.test.ts`).

**B2.** Pull's deletion pass does not mark files belonging to another database. Test (`pull-deletion-isolated.test.ts`): set up DB A → `_relay`, DB B → `_relay/B`. Pull A after B has files. A's deletion pass leaves B's files untouched.

**B3.** Legacy files (no `notion-database-id`) are backfilled during Pull when their `notion-id` matches a current row. Test (`pull-frontmatter-backfill.test.ts`).

**B4.** Run summary shows count of backfilled files. UI surface in diagnostics panel.

**B5.** Sync All applies per-entry overlap gate. Test (`sync-all-overlap.test.ts`): one entry overlaps, others don't — overlapping entry is rejected with reason, others run.

---

## §3 — Cluster C: Atomic Vault Content Writes (V8 + V9 Capability Ladder Extension)

### Problem

`writeDatabaseEntry`, page writes (standalone page sync), `.base` file generation, and `markAsDeleted` all use direct `app.vault.modify` or `app.vault.create`. Disk-full mid-write or adapter failure can leave torn files. The capability-ladder pattern (`plugin-data.ts:writePluginDataAtomic` and error-log writes in `main.ts`) is correct but not extended to vault content.

### Fix

> Amended in v0.9.9 to match implementation. See AUDIT-Stonerelay-v0.9.8-PostRelease and HANDOFF-Stonerelay-v0.9.9-AmendNotImplement.

**C1.** Create `src/atomic-vault-write.ts` — a single helper exposing `writeAtomic(vault, path, content, options?)` and `modifyAtomic(vault, file, content, options?)`. Implementation:
- Compute temp path: `<original>.<random-suffix>.tmp`
- Write content to temp
- Use adapter `rename` to replace original (capability A: rename-replace)
- If rename throws "destination exists" or capability-absent: fall back to (capability B: read-original → write-temp → write-final → remove-temp) and serialize fallback writes via a per-path lock exported from `reservations.ts` (or equivalent module-local lock primitive). A `ReservationManager` reservation is NOT required for adapter-fallback serialization, because the fallback path performs no Notion-side state mutation and therefore needs no cross-target reservation. The two lock types — `ReservationManager` reservation and per-path fallback lock — are intentionally distinct and serve different domains.
- If both capabilities fail: throw `AtomicWriteUnavailableError` with operator-actionable message; do NOT silently proceed
- Always clean up temp file in finally block
- Logs atomic-write event to action audit (action 31: atomic write committed)

**C2.** Replace direct `vault.modify` / `vault.create` in:
- `page-writer.ts:writeDatabaseEntry`
- `database-freezer.ts:markAsDeleted`
- `database-freezer.ts` (any other content-write site)
- `push.ts` frontmatter refresh (`refreshFrontmatterNotionId`)
- Any `.base` file generation site

`writeAtomic` / `modifyAtomic` is the only path; direct calls are a lint violation (add ESLint rule or test-time grep gate).

**C3.** Capability-ladder failure mode: if neither capability A nor B is available (rare; suggests catastrophic adapter), each affected operation surfaces a clear error per file, marks the row as failed, but does NOT abort the entire run. Run continues. Operator-visible diagnostic summarizes the count.

### Acceptance Criteria

**C1.** All vault content writes route through `writeAtomic`/`modifyAtomic`. Test (`atomic-write-coverage.test.ts`): grep test asserts no direct `vault.modify` / `vault.create` outside the helper.

**C2.** Disk-full mid-write produces no torn note. Test (`atomic-write-disk-full.test.ts`): mock adapter `write` to throw partway, original file content unchanged, temp file cleaned up.

**C3.** Capability A absent (no rename) — capability B path activates. Test (`atomic-write-no-rename.test.ts`).

**C4.** Capability-B fallback writes serialize via a per-path lock exported from `reservations.ts` (or equivalent module-local lock primitive), not a `ReservationManager` reservation. Test (`atomic-write-fallback-lock.test.ts`): normal capability-A writes run while a `ReservationManager` reservation is held, capability-B fallback writes run while the per-path fallback lock is held, and the two lock types have distinct identity.

**C5.** Both capabilities absent — clear operator error, row marked failed, run continues. Test (`atomic-write-no-caps.test.ts`).

**C6.** Action audit records atomic-write events (action 31).

---

## §4 — Cluster D: Duplicate notion-id Gate (V12)

### Problem

`validatePushCandidateFiles` does not check for duplicate `notion-id` values across the candidate set. Two files with the same `notion-id` in the push source folder produce silent last-writer-wins corruption: both files update the same Notion page, file ordering decides which content wins.

### Fix

**D1.** In `validatePushCandidateFiles`: build a Map of `notion-id` → file paths. If any id maps to >1 path, hard-block the entire Push with operator message listing all collisions:

```
Push blocked: duplicate notion-id values in source folder
  notion-id abc123: <path1>, <path2>
  notion-id def456: <path3>, <path4>, <path5>
Resolve duplicates before retrying. Stonerelay does not pick a winner automatically.
```

**D2.** Same gate applies to Sync All and Push All (per-entry, before each entry's push starts).

**D3.** During Pull, if `database-freezer.ts:scanLocalFiles` finds two files with the same `notion-id` (after the cluster B `notion-database-id` filter), surface a non-blocking warning in the run summary: "DB X has 2 local files claiming notion-id <id>: <path1>, <path2>. Pull updated only <path1>." Pull continues; the operator can fix manually.

**D4.** Diagnostics panel "Conflicts" section shows current duplicate-id state per database. Updates on every safety evaluation.

### Acceptance Criteria

**D1.** Push with duplicate `notion-id` files is hard-blocked before any Notion write. Test (`push-duplicate-id-block.test.ts`).

**D2.** Push All with one entry having duplicates fails that entry only; others proceed. Test (`push-all-duplicate-id-isolation.test.ts`).

**D3.** Pull duplicate-id warning surfaces in run summary. Test (`pull-duplicate-id-warning.test.ts`).

**D4.** Diagnostics panel reflects current duplicate state.

---

## §5 — Cluster E: Migration Safety Net (V20 + V21)

### Problem

`loadSettings` calls `migrateData(raw)` without try/catch. Invalid `notion-id` values, malformed nested objects, or corrupt `data.json` throw inside migration and prevent plugin load entirely. This is a Block: a single bad legacy id keeps the plugin permanently down.

### Fix

**E1.** Wrap `migrateData(raw)` in try/catch in `loadSettings`. On exception:
- Quarantine the raw settings: write `data.json` content to `<plugin-dir>/data-quarantine-<iso-timestamp>.json` (atomic helper)
- Load default settings (empty databases array, default global config)
- Surface a startup notice in Obsidian UI: "Stonerelay settings could not be loaded; defaults applied. Backup at `data-quarantine-<timestamp>.json`. See diagnostics for details."
- Persist a flag `settings_recovered_at: <timestamp>` so subsequent loads remember the recovery happened
- Diagnostics panel shows recovery banner with options: "Open quarantine file" / "Acknowledge and dismiss"

**E2.** Empty / null `data.json` recovers to defaults silently (current behavior preserved).

**E3.** Garbage / structurally invalid object goes through the quarantine path.

**E4.** Per-row migration errors (one bad database entry in an otherwise-valid settings) skip the bad entry, log to error log, and continue. The whole settings does NOT quarantine for one bad entry. Recovery notice lists skipped entries.

### Acceptance Criteria

**E1.** Plugin loads with default settings when `migrateData` throws. Test (`migration-throw-recovery.test.ts`): inject malformed `databaseId` → plugin starts with empty config + recovery notice.

**E2.** Quarantine file created on recovery. Test (`migration-quarantine.test.ts`).

**E3.** Recovery notice surfaces in diagnostics panel. Test (`migration-recovery-ui.test.ts`).

**E4.** One bad entry doesn't quarantine the whole settings. Test (`migration-partial-recovery.test.ts`).

**E5.** Recovery is idempotent across plugin reloads (banner persists until acknowledged). Test (`migration-recovery-persistence.test.ts`).

---

## §6 — Product-Design Implementations (V14 + V13)

### §6a — Per-Folder Seed Mode Toggle (V14)

Per [DEC-451](https://www.notion.so/Stonerelay-v0-9-7-product-design-questions-four-locks-35061ec214e6816ba155d5ca4d9ec20c) Q1.

**Schema addition** (per-database-entry, in `data.json`):
```ts
seed_mode: 'off' | 'on' | 'ask'
```

Default: `off`.

**Behavior:**
- `off`: id-less Markdown files in the database's resolved folder are skipped during Push. Listed in run summary as "skipped (no notion-id, seed mode off)."
- `on`: id-less files create new Notion pages (current v0.9.6 behavior).
- `ask`: on first Push encountering id-less files, modal prompts: "Folder `<path>` has N id-less files. Create them all in Notion (always-on)? Skip them all (always-off)? Decide each (per-file prompt)?" Operator's choice persists to `seed_mode` field. The "decide each" option doesn't persist; it surfaces a per-file modal during the Push.

**New folders detected** (folder added to settings via Edit Database UI): default `off`. UI surfaces "Seed mode: off — id-less files are skipped. Change in folder settings."

**Standalone page sync** is out of scope for seed mode (different code path, single-file model).

### §6b — Stale notion-id Remediation (V13)

Per [DEC-451](https://www.notion.so/Stonerelay-v0-9-7-product-design-questions-four-locks-35061ec214e6816ba155d5ca4d9ec20c) Q2.

When `push.ts` detects a file with `notion-id` not present in the current `byId` lookup:

1. Check Notion trash (via `pages.retrieve` with archived included). If page is in trash and within 30-day window, present "Restore from Notion trash" option.
2. If page is permanently deleted (404 from `pages.retrieve`), don't surface the restore option.
3. Always surface: "Recreate (clear stale id, push as new row)" and "Delete local file (mirror Notion deletion)".
4. Always allow: "Skip" (escape hatch for "deal with it later").

**Modal copy** (operator-facing):
```
Stale notion-id detected: <vault-path>
  Notion-id <id> not found in <db-name>.

  □ Recreate (clear id, push as new row → file gets a fresh notion-id)
  □ Restore from Notion trash (only available within 30 days)  ← shown only if available
  □ Delete local file (page is gone; mirror locally)
  □ Skip (deal with it later — file stays as-is)

  [Apply to all stale ids in this run] (checkbox)
  [Apply] [Cancel]
```

**Per-file vs batch:** by default per-file. The "Apply to all stale ids in this run" checkbox lets operator choose once and apply to all stale rows in the current Push.

**During Sync All / Push All:** if any entry has stale ids, that entry's Push pauses for the modal. Operator can choose "Skip all stale in this batch" to defer remediation per-entry.

### Acceptance Criteria

**§6a.1.** Newly added databases default `seed_mode: off`. Test (`seed-mode-default-off.test.ts`).

**§6a.2.** Push with `seed_mode: off` skips id-less files and lists them in run summary. Test (`seed-mode-off-skip.test.ts`).

**§6a.3.** Push with `seed_mode: ask` triggers modal on first id-less encounter, persists choice. Test (`seed-mode-ask-persist.test.ts`).

**§6a.4.** Push with `seed_mode: on` creates pages from id-less files (existing behavior preserved). Test (`seed-mode-on-create.test.ts`).

**§6a.5.** Migration v5 → v6 adds `seed_mode: off` to all existing entries.

**§6b.1.** Stale notion-id triggers remediation modal. Test (`stale-id-modal.test.ts`).

**§6b.2.** "Recreate" clears the stale id and pushes as new. Test (`stale-id-recreate.test.ts`).

**§6b.3.** "Restore from trash" calls `pages.update` with `archived: false` when page is in 30-day window. Test (`stale-id-restore.test.ts`).

**§6b.4.** "Delete local file" removes the file via atomic helper (cluster C). Test (`stale-id-delete-local.test.ts`).

**§6b.5.** "Skip" preserves current v0.9.6 behavior. Test (`stale-id-skip.test.ts`).

**§6b.6.** "Apply to all in this run" applies the chosen action to all stale rows. Test (`stale-id-batch-apply.test.ts`).

---

## §7 — Out of Scope (Deferred to v0.9.8+)

Documented for clarity. Do not implement in v0.9.7.

- **V2** Group rename mid-sync race (Degrade)
- **V3** Database removed mid-sync (Degrade)
- **V6** Notion 429/5xx idempotency metadata (Degrade)
- **V7** 401 fatal-after-first classification (Degrade)
- **V10** AbortSignal + timeout in `notionRequest` (Degrade — pulled in only as far as cluster A's cancel path needs)
- **V11** Structured YAML parser for frontmatter (Degrade)
- **V13** Permanent-delete remediation (out of v0.9.7 scope; only 30-day trash restore handled)
- **V15** Push All stale-id batch UX polish (basic gate from §6b.6 covers; advanced UX deferred)
- **V16** File rename mid-sync revalidation (Degrade)
- **V17** File deleted mid-sync re-check (Degrade)
- **V18** Folder deleted mid-sync gate (Degrade)
- **V19** Notion archived row classification (Degrade — basic skip handled in cluster B/D paths)
- **V22** Settings external-modification detection (Degrade)
- **V23** Group config drift cleanup (Cosmetic)
- **V24** Error-log write collision (Degrade)
- **V25** Error-log path invalid mid-session (Degrade)
- **V26** Diagnostics panel data-race "as of" timestamp (Cosmetic)
- **V27** BRAT loaded-code drift detection — **DEFERRED INDEFINITELY** to nice-to-haves backlog ([DEC-451](https://www.notion.so/Stonerelay-v0-9-7-product-design-questions-four-locks-35061ec214e6816ba155d5ca4d9ec20c) Q3)
- **V29** Pull deletion pass row-isolation (Degrade)
- **V30** Legacy `databases.retrieve` dependency removal (Degrade — refactor to data-source-first)

---

## §8 — Test Plan Summary

Aggregate test count: **38 new tests** across 5 clusters + product-design. Existing tests must continue to PASS unchanged.

Test file naming convention: descriptive kebab-case under `tests/`. Match `obsidian-mock.ts` and existing fixture patterns.

**Critical coverage:**
- Reservation primitive: 6 tests (cluster A acceptance)
- Pull safety symmetry: 5 tests (cluster B acceptance)
- Atomic vault writes: 6 tests (cluster C acceptance)
- Duplicate id gate: 4 tests (cluster D acceptance)
- Migration safety: 5 tests (cluster E acceptance)
- Seed mode: 5 tests (§6a acceptance)
- Stale-id remediation: 6 tests (§6b acceptance)
- Schema migration v5 → v6 idempotency: 1 test (covers cluster A schema and §6a default-off)

**Runtime smoke test** (per `~/.claude/skills/codex-handoff/SKILL.md`): instantiate plugin entry against capability variants — adapter with rename (full caps), without rename (cluster C capability B), without rename or atomic-replace (cluster C capability ladder failure). All must not throw at `onload()`.

---

## §9 — Release Procedure

1. Bump `manifest.json`, `package.json`, `versions.json` → `0.9.7`.
2. Update `ADVERSARY_CHANGES.md`: `## v0.9.7 — Lifecycle Unification + Safety Symmetry + Atomic Writes` with date and change summary referencing the 5 clusters + 2 product-design surfaces.
3. `git add src/ tests/ manifest.json package.json versions.json ADVERSARY_CHANGES.md` (verify with `git status`; do NOT stage `_artifacts/`, the spec file, or any operator-authored markdown).
4. `git commit -m "v0.9.7 — Lifecycle Unification + Safety Symmetry + Atomic Writes"`.
5. `git tag v0.9.7`.
6. `git push origin main`.
7. `git push origin v0.9.7` (single tag, NOT `--tags`).
8. Extract release notes: `awk '/^## v0\.9\.7/,/^## v/' ADVERSARY_CHANGES.md > /tmp/stonerelay-v0.9.7-notes.md`.
9. `gh release create v0.9.7 --repo adversarydsgn/stonerelay --title "v0.9.7 — Lifecycle Unification + Safety Symmetry + Atomic Writes" --notes-file /tmp/stonerelay-v0.9.7-notes.md main.js manifest.json styles.css` (Obsidian plugin: positional asset args at end).
10. Verify release: `gh release view v0.9.7 --repo adversarydsgn/stonerelay`.

---

## §10 — Verification Gate

Codex's "done" must mean ALL of:

- [ ] Code committed (narrow staging; no operator markdown in repo root or `_artifacts/`)
- [ ] `manifest.json`, `package.json`, `versions.json` all show `0.9.7`
- [ ] `npm test` PASS (38+ new tests + all existing tests green)
- [ ] `npm run build` PASS
- [ ] `git diff --check` PASS
- [ ] **Runtime smoke test** for capability variants (cluster C ladder) — three variants tested
- [ ] All §1-§6 acceptance criteria reported individually as PASS or FAIL
- [ ] Release v0.9.7 created and verified
- [ ] Tag pushed individually (not `--tags`)
- [ ] No upstream tag leakage

**If any criterion is FAIL:** do not release. Write a decision-request handoff back identifying the failed criterion and proposed remediation.

---

## §11 — Conventions (apply throughout)

Per `~/.codex/AGENTS.md` and `~/.claude/skills/codex-handoff/SKILL.md`:

- **lowercase `adversary`** in all org/handle references.
- **Plain semver** v0.9.7. No `-adv` suffix.
- **Conventional commits** for incremental work. Final version commit follows the pattern in §9.
- **`ADVERSARY_CHANGES.md` is release-facing.** Defaulted-copy notes / deferred items / "had to guess on X" reports go in the **final report-back**, not the changelog.
- **Stage explicitly.** No `git add -A` even though §9 example may resemble it. List paths only.
- **Repos remain private.** No public-flip in this work.
- **awk pattern** in §9 step 8 terminates on next version heading (`^## v`), not every `^## ` heading.
- **Single tag push.** No `git push --tags`.
- **gh release create** includes `--repo adversarydsgn/stonerelay` and asset positional args (`main.js manifest.json styles.css`) at the end (Obsidian plugin pattern).
- **Match existing repo patterns** — vitest config, esbuild build, TypeScript strictness, error-log format, settings-data shapes. Do not introduce new tooling.
- **Reuse `src/notion-client.ts`** — do not build a second Notion client.
- **Use current Notion API** — `client.dataSources.retrieve` / `client.dataSources.query`. Do not introduce new `client.databases.*` calls. The existing `client.databases.retrieve` calls (V30) are out of scope to remove in v0.9.7 but DO NOT add new uses.
- **Capability-ladder discipline** — vault content writes (cluster C) follow the pattern from `plugin-data.ts:writePluginDataAtomic`. Acceptance criteria are NOT load-blocking invariants; they're degraded-path defined.
- **Iteration gate:** if 3 consecutive iterations on the same cluster make no progress against acceptance criteria, stop and write a decision-request handoff back. Test-fix loops that close ACs are not violations.

---

## §16 — Abort Protocol

Per `~/.codex/AGENTS.md` SPEC-DRIVEN protocol.

The following items **must resolve before implementation begins**:

- **§16.1.** Verify the chaos audit at `_artifacts/audits/AUDIT-Stonerelay-v0.9.6-ChaosFailureModes-20260427-234708Z.md` exists and matches the v0.9.6 commit referenced. If audit was generated against a different commit than current `HEAD`, flag and abort.
- **§16.2.** Verify that no in-progress branch / uncommitted work in the repo (this spec is on `main`, drafted SES-383). `git status` should be clean before starting. Untracked `_artifacts/` and the spec markdown are expected; commit nothing else as starting state.
- **§16.3.** Verify Codex has read `~/.codex/AGENTS.md` and `~/.claude/skills/codex-handoff/SKILL.md` for current convention coverage.
- **§16.4 (threshold gate).** Total test count target is 38+. If during implementation you discover the cluster needs >50 tests (more than 30% over target), flag it as scope-expansion before continuing. Do not silently expand.

If any §16 item cannot be verified, **abort implementation and write a decision-request handoff back**. Do not solo-decide.

---

## §17 — Drop-Ins

This spec moves to in-flight when handed to Codex via paste-ready handoff. Once in-flight, this file is **immutable**. Changes arrive as drop-ins — inline amendments in the executing session conversation or Notion callouts on the spec page, applied in order after the base spec is read.

---

## §18 — Estimated Time

Per `~/.claude/skills/codex-handoff/SKILL.md` time multiplier rule: **invasive surgery to core sync loops** triggers 1.2× multiplier.

- Cluster A (reservation primitive): 6-8 hours base × 1.2 = 7-10 hours
- Cluster B (Pull safety symmetry): 3-4 hours
- Cluster C (atomic writes): 4-5 hours base × 1.2 = 5-6 hours
- Cluster D (duplicate-id gate): 2 hours
- Cluster E (migration safety): 2-3 hours
- §6a seed mode: 3-4 hours (UI + tests)
- §6b stale-id remediation: 4-5 hours (modal + Notion trash check + tests)
- Test scaffolding + fixtures: 3-4 hours
- Release procedure + smoke test + verification: 1-2 hours

**Total: 30-40 hours.** This is a substantial release, not a patch. If your Codex session can't budget for this, flag and split into v0.9.7 (clusters A-D) + v0.9.8 (cluster E + product-design surfaces) before starting.

---

*Spec drafted SES-383 (Code, Opus 1M, 2026-04-27) post chaos audit + product-design lock. Status: being-planned. Move to in-flight when handed off via Codex paste-ready brief.*
