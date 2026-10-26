/**
 * The files that may read the provider fact tables or the ledgers, or sum tokens and amounts in SQL
 * (plan U4.7, golden rules §1). Everything else reads day sums through `server/ledger-sums.ts` and
 * window sums through the `server/window-usage.ts` read API. `reads` and `sums` are the exact counts
 * the guard finds (`single-source-scan.ts`): adding a read or a sum to a listed file changes them, so
 * every new one is a visible, reviewed line here. A new calculation extends the ledger instead.
 *
 * Kinds:
 * - register: the read modules of the ledgers and window sums (the one place screens get numbers);
 * - producer: builds the ledgers or window sums from the facts;
 * - ingest: parses provider files into fact tables or publishes them;
 * - detail: reads single facts, not totals (a call list, one window's time axis, identities, presence);
 * - maintenance: diagnostics and data upkeep outside screens;
 * - legacy: a screen total still computed from the facts; to be moved to the ledger (listed in the U4.7 report).
 */
export type SingleSourceKind = "register" | "producer" | "ingest" | "detail" | "maintenance" | "legacy";
export interface SingleSourceEntry { reads: number; sums: number; kind: SingleSourceKind; reason: string }

export const SINGLE_SOURCE_ALLOWED: Readonly<Record<string, SingleSourceEntry>> = {
  "db/first-token.ts": { reads: 8, sums: 0, kind: "producer", reason: "atomically canonicalizes turn timing copies and updates only their exact hourly histogram contributions" },
  "server/first-token-read.ts": { reads: 2, sums: 0, kind: "register", reason: "reads prepared TTFT histograms and bounded canonical turns only at dated ownership boundaries" },
  // Read modules of the ledgers and window sums.
  "server/ledger-sums.ts": { reads: 41, sums: 12, kind: "register", reason: "the one read module of day and hour sums of both ledgers (timed sums included, the Codex owned timed hours of Speed among them), of their missing-rate valuations, of an account's stored activity and Codex calls, tokens and activity per owner (facts only across an ownership boundary or for mixed sessions), of the day rows' rate keys (a row the project cost cannot split from its sums read from its own calls) and of the calls' stored gaps of selected day rows (wall-clock activity per computer)" },
  "server/window-usage-read.ts": { reads: 5, sums: 0, kind: "register", reason: "stored window sums, prepared model-capacity samples and model usage share behind the window-usage read API" },
  "server/window-usage-events.ts": { reads: 1, sums: 0, kind: "register", reason: "the ledger sources an account reads for bounded window computations" },
  "server/window-usage-producer.ts": { reads: 6, sums: 0, kind: "producer", reason: "publishes window sums from shared ledgers and compares stored rows before writing" },
  "server/window-usage-invalidation.ts": { reads: 3, sums: 0, kind: "producer", reason: "queues changed window definitions and reference variants without recomputing unaffected sums" },
  "server/window-usage-intervals.ts": { reads: 2, sums: 0, kind: "producer", reason: "tracks ledger revisions while publishing the configured and fallback interval list" },
  "db/usage-ledger-read.ts": { reads: 6, sums: 0, kind: "register", reason: "usage ledger readiness and day reads behind ledger-sums, including unencoded account-history day measures and the stored contributions of a period-cut source day" },
  "db/usage-ledger-events.ts": { reads: 9, sums: 0, kind: "register", reason: "the usage ledger's priced events for the window producers, and the identities with a copy of a project in range" },
  "db/codex-price-ledger.ts": { reads: 34, sums: 11, kind: "register", reason: "Codex ledger state, aggregates (whole hours and the pieces a window or range cuts), per-file model rows, window cohorts, calls and source burn read API, the timed sums of days whose response times alone changed and the activity gaps and sums" },
  "db/codex-ledger-adapters.ts": { reads: 8, sums: 1, kind: "register", reason: "Codex ledger read contexts and stamps for readers, including SQL-summed canonical stored day groups for account history (period-cut days use the shared slicer)" },
  "db/codex-ledger-canonical.ts": { reads: 18, sums: 0, kind: "register", reason: "the canonical-copy predicate every Codex fact read uses; a fork's replayed parent calls and readings are found here, and the conversations still holding a removed call's response id" },

  // Producers.
  "server/subscription-rate.ts": { reads: 1, sums: 0, kind: "producer", reason: "publishes dated capacity facts from stored window_usage sums and native provider calibration, never reprices source events" },
  "server/project-plan-producer.ts": { reads: 1, sums: 0, kind: "producer", reason: "checks only source fact presence before admitting ready ledger coverage; project values come through the canonical ledger read API" },
  "server/usage-ledger-producer.ts": { reads: 42, sums: 3, kind: "producer", reason: "builds the usage ledger from the provider fact tables, reconciles their changed days, re-sums the timed calls of days whose response times alone changed, re-reads the rows a changed mode rule affects and recomputes the activity gaps of changed sessions" },
  "server/window-end-estimate.ts": { reads: 2, sums: 0, kind: "producer", reason: "stores the end estimates of closed limit windows from their stored window sums rows (window_usage), never from facts" },
  "server/window-point-values.ts": { reads: 3, sums: 0, kind: "producer", reason: "stores the value of one point of each limit window from its stored window sums row (window_usage: paired usage and the running sums at the limit reading), never from facts" },
  "server/billing-cycle-producer.ts": { reads: 3, sums: 0, kind: "producer", reason: "stores billing cycles from the stored window sums rows (window_usage: whole-window usage, running sums of a window a cycle boundary cuts, Claude's declared windows), never from facts" },
  "db/fact-day-revisions.ts": { reads: 2, sums: 0, kind: "producer", reason: "the fact tables' changed source days (triggers and a first fill's bulk record)" },
  "db/codex-ledger-fill.ts": { reads: 20, sums: 0, kind: "producer", reason: "fills the Codex ledger from Codex events and their activity gaps" },
  "db/codex-ledger-producer.ts": { reads: 8, sums: 0, kind: "producer", reason: "advances the Codex ledger and its activity gaps" },
  "db/codex-ledger-copies.ts": { reads: 10, sums: 0, kind: "producer", reason: "Codex canonical copy selection in the ledger" },

  // Ingest and publication.
  "ingest/claude.ts": { reads: 5, sums: 0, kind: "ingest", reason: "Claude parser writes claude_events" },
  "ingest/claude-first-fill.ts": { reads: 2, sums: 0, kind: "ingest", reason: "Claude bulk first fill" },
  "ingest/codex.ts": { reads: 7, sums: 0, kind: "ingest", reason: "Codex parser writes events" },
  "ingest/gemini.ts": { reads: 4, sums: 0, kind: "ingest", reason: "Gemini parser writes gemini_events" },
  "ingest/grok.ts": { reads: 3, sums: 0, kind: "ingest", reason: "Grok parser writes grok_events" },
  "ingest/opencode.ts": { reads: 3, sums: 0, kind: "ingest", reason: "OpenCode parser writes oc_events" },
  "sync/coordinator.ts": { reads: 1, sums: 0, kind: "ingest", reason: "checks whether project-remapped facts exist before vendor publication" },
  "sync/source-input-selection.ts": { reads: 1, sums: 0, kind: "ingest", reason: "selects bounded source rereads from accepted bookmarks" },
  "sync/stage-bookmarks.ts": { reads: 2, sums: 0, kind: "ingest", reason: "preserves and proves accepted reading positions during publication" },
  "sync/incremental-stage.ts": { reads: 6, sums: 0, kind: "ingest", reason: "copies and validates facts and identity evidence in an isolated stage" },
  "sync/publication-identities.ts": { reads: 7, sums: 0, kind: "ingest", reason: "finds source identities and timestamp ranges affected by publication" },
  "sync/claude-source-publication.ts": { reads: 5, sums: 0, kind: "ingest", reason: "merges Claude source records and limit hits during publication" },
  "sync/incremental-publication.ts": { reads: 11, sums: 0, kind: "ingest", reason: "compares and publishes changed source facts inside one transaction" },
  "sync/vendor-source-preparation.ts": { reads: 4, sums: 0, kind: "ingest", reason: "prepares staged inputs and verifies source evidence after parsing" },
  "sync/vendor-first-fill.ts": { reads: 5, sums: 0, kind: "ingest", reason: "transfers first-fill stage facts and commits the publication receipt" },
  "sync/vendor-delta-publication.ts": { reads: 1, sums: 0, kind: "ingest", reason: "removes unproven staged evidence after bounded source reconciliation" },
  "sync/source-impact.ts": { reads: 11, sums: 1, kind: "ingest", reason: "semantic diff of a stage publication (row counts and sizes)" },
  "sync/account-selection.ts": { reads: 1, sums: 0, kind: "ingest", reason: "identity selection on a stage during publication" },
  "projects/remap.ts": { reads: 5, sums: 0, kind: "ingest", reason: "rewrites the repository of fact rows after a repository configuration change" },

  // Detail reads: single facts, identities and presence, not totals.
  "server/api-codex-ledger.ts": { reads: 2, sums: 0, kind: "detail", reason: "Codex call list of one window from the ledger" },
  "server/codex-limit-windows.ts": { reads: 2, sums: 0, kind: "detail", reason: "transcript limit readings and models of one file" },
  "server/codex-source-account.ts": { reads: 3, sums: 0, kind: "detail", reason: "distinct Codex homes for account discovery (an index skip-scan)" },
  "server/codex-timeline-markers.ts": { reads: 1, sums: 0, kind: "detail", reason: "first use of each model (timeline markers)" },
  "server/codex-ledger-settings-http.ts": { reads: 1, sums: 0, kind: "detail", reason: "service-tier call counts for the ledger settings form" },
  "server/claude-event-account.ts": { reads: 4, sums: 0, kind: "detail", reason: "Claude session identities (account keys)" },
  "server/vendor-discovery.ts": { reads: 1, sums: 0, kind: "detail", reason: "distinct Claude account keys for discovery" },
  "server/analysis-rebuild.ts": { reads: 1, sums: 0, kind: "detail", reason: "presence of an identity in Claude events before a rebuild" },
  "server/plan-health-read.ts": { reads: 1, sums: 0, kind: "detail", reason: "per-file evidence for the spark classifier" },
  "server/source-health.ts": { reads: 2, sums: 0, kind: "detail", reason: "last activity per source and account (health, not totals)" },
  "server/project-cost-codex.ts": { reads: 2, sums: 0, kind: "detail", reason: "presence checks of Codex inputs before prepared project-ledger reads" },
  "server/project-cost-daily.ts": { reads: 1, sums: 0, kind: "detail", reason: "presence check of Codex inputs before returning a project aggregate memo hit" },
  "server/subscription-usage.ts": { reads: 1, sums: 0, kind: "detail", reason: "day span of the Codex ledger aggregates" },
  "server/account-scope.ts": { reads: 1, sums: 0, kind: "detail", reason: "indexed source homes for account-scoped reports" },
  "server/api-events.ts": { reads: 5, sums: 0, kind: "detail", reason: "bounded call lists and their stored source/account evidence (formerly handleEvents in api.ts)" },
  "server/api-health.ts": { reads: 1, sums: 0, kind: "detail", reason: "health presence checks for the event and observation tables" },
  "server/api-accounts.ts": { reads: 3, sums: 0, kind: "detail", reason: "account source identities and stored first/last call and call counts" },
  "server/server-sync.ts": { reads: 1, sums: 0, kind: "detail", reason: "index emptiness check before synchronization and startup remap" },
  "server/server-remap.ts": { reads: 1, sums: 0, kind: "detail", reason: "table row counts in remap progress diagnostics" },
  "server/api-cycle-settings.ts": { reads: 2, sums: 0, kind: "detail", reason: "stored window and source presence for editable cycle settings" },
  "server/api-provider-limits.ts": { reads: 1, sums: 0, kind: "detail", reason: "latest stored Grok credit-pool reading for reset-anchor settings" },

  "projects/parents.ts": { reads: 2, sums: 0, kind: "detail", reason: "stored source and conversation provenance for parent project inheritance; no raw calls or repricing" },
  "server/claude-limit.ts": { reads: 1, sums: 0, kind: "detail", reason: "bounded probe evidence for Claude observation metadata; traffic comes from stored window usage" },

  // Maintenance outside screens.
  "config/archive-location.ts": { reads: 1, sums: 0, kind: "maintenance", reason: "emptiness check before an archive relocation" },
  "config/archive-relocation-restart-worker.ts": { reads: 4, sums: 4, kind: "maintenance", reason: "row and token checksums verifying a relocation" },
  "doctor.ts": { reads: 2, sums: 0, kind: "maintenance", reason: "CLI table counts" },
  "verify.ts": { reads: 6, sums: 10, kind: "maintenance", reason: "CLI data verification report" },

};
