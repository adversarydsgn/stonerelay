# Adversary Changes

Fork-side changes to `stonerelay` (vs. upstream `ran-codes/obsidian-notion-database-sync`).

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
