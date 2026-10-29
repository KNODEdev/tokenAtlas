# tokenAtlas application

This is the active application repository: `KNODEdev/tokenAtlas`, branch `main`,
with the new public history. Verify locally; never add, trigger, poll or require
GitHub Actions. Keep secrets, transcripts, databases and installation declarations
out of Git. Use synthetic fixtures and preserve third-party license notices.

## Owner constraints

- Preserve the approved desktop interface. Do not change layout, navigation,
  typography, colours or control placement without explicit permission. No mobile
  layouts or phone verification. Use the IBM Plex paper-atlas design in
  `docs/design/paper-atlas.md`; prefer shared tokens and primitives.
- On screen use concise labels and numbers; explanations, provenance and exact
  timestamps belong in tooltips/HelpDots. Do not reinstate CurrentApp or a separate
  Portfolio entry. Keep data work separate from visual changes.
- Read `docs/golden-rules.md` before changing data, calculations, sync, persistence
  or analytical reads. All modules share durable calculated facts, updated
  incrementally in background producers. Ordinary reads do not rebuild history.
  Preserve precision, provenance, missing-data semantics and completed work.
- Read `docs/provider-contract.md` for shared provider, ledger and meter rules.
  Accounts/plans are dated periods, not stamps on events. Parameters and plan
  identities have one meaning and resolver across server and browser.
- Resolve database, archive, config, local state and temp through the shared Settings/path
  functions. Originals go to the growing archive; calculated local databases,
  cursors and scratch files do not belong in the shared source archive.
  The first-install/Settings database choice is saved in private `tokenatlas.local.json`;
  local machine state lives in `local-state/` beside the chosen database. Preserve that
  state when moving the database. Do not require users to configure these paths in `.env`.
- Only the running server writes the live database. Tests that change real data use
  fixtures or one isolated copy, deleted after verification; routine code work and
  read-only checks require no database copy. Live migrations, server restarts and installed bundle replacement need
  the owner's decision; a source migration is not permission to activate it.
- Keep comments brief and in English, explaining non-obvious constraints.

## Local maintainer context

When `.local-maintainer/AGENTS.md` exists, read it for retained owner decisions,
pending activation notes and private verification evidence. This optional local
context is ignored; do not commit or publish it. Historical branch names and
repository locations in that archived context do not replace the active `main`
repository described above. Other contributors need no private checkout.

## Current source state

The latest local window lifecycle, dated meter evidence and omitted Codex mode
changes were carried into this working tree during the local cutover on
2026-10-25. They remain local working changes. The owner subsequently authorized
activation: the live database is through 0095, and the frontend/server include TTFT
table/chart support and saved local settings. Historical TTFT backfill continues in
the existing background writer. See `docs/verification/first-token-2026-10-25.md`.
