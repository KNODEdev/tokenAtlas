import { sqliteTable, text, integer, real, index, uniqueIndex, primaryKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const claudeEvents = sqliteTable(
  "claude_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    store: text("store").notNull(),
    call_id: text("call_id").notNull(),
    session_id: text("session_id"),
    request_id: text("request_id"),
    ts: text("ts").notNull(),
    model: text("model"),
    effort: text("effort"),
    project: text("project"),
    cwd: text("cwd"),
    git_branch: text("git_branch"),
    entrypoint: text("entrypoint"),
    is_sidechain: integer("is_sidechain").notNull().default(0),
    agent_id: text("agent_id"),
    attribution_agent: text("attribution_agent"),
    service_tier: text("service_tier"),
    speed: text("speed"),
    cc_version: text("cc_version"),
    path: text("path").notNull(),
    in_uncached: integer("in_uncached").notNull().default(0),
    in_cache_read: integer("in_cache_read").notNull().default(0),
    in_cache_write: integer("in_cache_write").notNull().default(0),
    cache_write_5m: integer("cache_write_5m").notNull().default(0),
    cache_write_1h: integer("cache_write_1h").notNull().default(0),
    out_total: integer("out_total").notNull().default(0),
    out_thinking: integer("out_thinking").notNull().default(0),

    project_id: text("project_id"),

    subscription_id: text("subscription_id"),
    account_key: text("account_key"),

    subscription_conflict: integer("subscription_conflict").notNull().default(0),
    /** Milliseconds from the user record a call answers to its last block (parser 6); null when unknown. */
    resp_ms: integer("resp_ms"),
    /** 'grant' when the provider billed the call from a promotional cloud credit (migration 0092); null otherwise. */
    billing_mode: text("billing_mode"),
  },
  (table) => [
    index("claude_events_store_ts_idx").on(table.store, table.ts),
    index("claude_events_ts_idx").on(table.ts),
    index("claude_events_project_id_idx").on(table.project_id),
    index("claude_events_store_path_idx").on(table.store, table.path),
    index("claude_events_subscription_id_idx").on(table.subscription_id),
    index("claude_events_model_idx").on(table.model),
    uniqueIndex("claude_events_store_call_id_unique").on(table.store, table.call_id),
  ]
);

/** Vendor refusals at a reached limit, read from Claude Code transcripts (migration 0043). */
export const claudeLimitHits = sqliteTable(
  "claude_limit_hits",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    store: text("store").notNull(),
    call_id: text("call_id").notNull(),
    session_id: text("session_id"),
    ts: text("ts").notNull(),
    /** Vendor counter, or the counter interpreted from archived refusal text. */
    limit_type: text("limit_type").notNull(),
    status: text("status").notNull(),
    /** Whether the type came from the vendor, explicit refusal text, or reset-distance inference. */
    type_basis: text("type_basis").notNull().default("vendor"),
    resets_at: text("resets_at"),
    path: text("path").notNull(),
    subscription_id: text("subscription_id"),
    account_key: text("account_key"),
    subscription_conflict: integer("subscription_conflict").notNull().default(0),
  },
  (table) => [
    uniqueIndex("claude_limit_hits_store_call_id_unique").on(table.store, table.call_id),
    index("claude_limit_hits_store_path_idx").on(table.store, table.path),
    index("claude_limit_hits_ts_idx").on(table.ts),
  ]
);

export const claudeFiles = sqliteTable(
  "claude_files",
  {
    store: text("store").notNull(),
    path: text("path").notNull(),
    parser_version: integer("parser_version").notNull().default(0),
    size: integer("size").notNull(),
    mtime: real("mtime").notNull(),
    calls: integer("calls").notNull().default(0),
    ingested_at: text("ingested_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.store, table.path] }),
  ]
);

export const ocEvents = sqliteTable(
  "oc_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    store: text("store").notNull(),
    message_id: text("message_id").notNull(),
    session_id: text("session_id"),
    ts: text("ts").notNull(),
    model: text("model"),
    provider: text("provider"),
    agent: text("agent"),
    mode: text("mode"),
    project: text("project"),
    directory: text("directory"),
    in_tok: integer("in_tok").notNull().default(0),
    out_tok: integer("out_tok").notNull().default(0),
    reasoning: integer("reasoning").notNull().default(0),
    cache_read: integer("cache_read").notNull().default(0),
    cache_write: integer("cache_write").notNull().default(0),
    cost: real("cost").notNull().default(0),

    project_id: text("project_id"),
  },
  (table) => [
    index("oc_events_store_ts_idx").on(table.store, table.ts),
    index("oc_events_ts_idx").on(table.ts),
    index("oc_events_project_id_idx").on(table.project_id),
    index("oc_events_model_idx").on(table.model),
    uniqueIndex("oc_events_store_message_unique").on(table.store, table.message_id),
  ]
);

export type OcEvent = typeof ocEvents.$inferSelect;
export type NewOcEvent = typeof ocEvents.$inferInsert;

export type ClaudeEvent = typeof claudeEvents.$inferSelect;
export type NewClaudeEvent = typeof claudeEvents.$inferInsert;
export type NewClaudeLimitHit = typeof claudeLimitHits.$inferInsert;
export type ClaudeFile = typeof claudeFiles.$inferSelect;
export type NewClaudeFile = typeof claudeFiles.$inferInsert;

export const probeWindows = sqliteTable(
  "probe_windows",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    provider: text("provider").notNull(),

    subject: text("subject").notNull(),
    ts: text("ts").notNull(),

    plan: text("plan"),
    kind: text("kind").notNull(),

    limit_group: text("limit_group"),

    scope: text("scope"),
    reported_percent_side: text("reported_percent_side").notNull(),
    used_percent: real("used_percent"),
    remaining_percent: real("remaining_percent"),

    vendor_percent: real("vendor_percent"),
    window_minutes: real("window_minutes"),
    allowance: real("allowance"),
    used: real("used"),
    remaining: real("remaining"),
    resets_at: text("resets_at"),
    rate_limit_reached: integer("rate_limit_reached"),
    reset_credits: integer("reset_credits"),
    profile: text("profile"),
    ok: integer("ok"),
    error: text("error"),
    extra: text("extra"),

    // Which PC took the sample. NULL on rows written before the cross-machine
    // journal existed: some of those arrived through a snapshot of another
    // machine, so backfilling the local name would be a guess.
    machine: text("machine"),
  },
  (table) => [
    index("probe_windows_provider_subject_ts_idx").on(table.provider, table.subject, table.ts),
    // Cross-machine ingest dedupes on (provider, ts, ...) without the subject,
    // because an era re-stamp may have rewritten the subject since the sample
    // was journaled.
    index("probe_windows_provider_ts_idx").on(table.provider, table.ts),
    index("probe_windows_lookup_idx").on(table.provider, table.subject, table.limit_group, table.kind, table.ts),
    index("probe_current_key_lookup").on(table.provider, sql`lower(subject)`, table.kind,
      sql`coalesce(limit_group, '')`, sql`coalesce(scope, '')`,
      sql`coalesce(window_minutes, -1)`, sql`julianday(ts) DESC`, sql`id DESC`),
    index("probe_current_subject_lookup").on(table.provider, sql`lower(subject)`, sql`julianday(ts) DESC`, sql`id DESC`),
    uniqueIndex("probe_windows_claude_sample_unique")
      .on(table.provider, table.subject, table.kind, table.limit_group, table.scope, table.ts)
      .where(sql`${table.provider} = 'claude'`),
    uniqueIndex("probe_windows_codex_sample_unique")
      .on(table.provider, table.subject, table.limit_group, table.kind, table.ts)
      .where(sql`${table.provider} = 'codex'`),
    uniqueIndex("probe_windows_gemini_sample_unique")
      .on(table.provider, table.subject, table.limit_group, table.kind, table.ts)
      .where(sql`${table.provider} = 'gemini'`),
    uniqueIndex("probe_windows_glm_sample_unique")
      .on(table.provider, table.subject, table.kind, table.ts)
      .where(sql`${table.provider} = 'glm'`),
  ]
);

export type ProbeWindow = typeof probeWindows.$inferSelect;
export type NewProbeWindow = typeof probeWindows.$inferInsert;

export const grokEvents = sqliteTable(
  "grok_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    store: text("store").notNull(),
    source_id: text("source_id").notNull().default(""),
    session_id: text("session_id").notNull(),

    prompt_id: text("prompt_id").notNull(),
    ts: text("ts").notNull(),
    model: text("model"),
    stop_reason: text("stop_reason"),

    cwd: text("cwd"),

    project: text("project"),

    path: text("path").notNull(),

    in_tok: integer("in_tok").notNull().default(0),
    cached_in: integer("cached_in").notNull().default(0),
    cache_write: integer("cache_write").notNull().default(0),
    out_tok: integer("out_tok").notNull().default(0),
    reasoning: integer("reasoning").notNull().default(0),

    model_calls: integer("model_calls").notNull().default(0),
    api_duration_ms: integer("api_duration_ms").notNull().default(0),

    cost_ticks: integer("cost_ticks").notNull().default(0),

    project_id: text("project_id"),
  },
  (table) => [
    index("grok_events_store_ts_idx").on(table.store, table.ts),
    index("grok_events_ts_idx").on(table.ts),
    index("grok_events_store_path_idx").on(table.store, table.path),
    index("grok_events_project_id_idx").on(table.project_id),
    index("grok_events_model_idx").on(table.model),
    uniqueIndex("grok_events_turn_unique").on(table.store, table.source_id, table.session_id, table.prompt_id, table.model),
  ]
);

export type GrokEvent = typeof grokEvents.$inferSelect;
export type NewGrokEvent = typeof grokEvents.$inferInsert;

export const grokFiles = sqliteTable(
  "grok_files",
  {
    store: text("store").notNull(),
    source_id: text("source_id").notNull().default(""),
    path: text("path").notNull(),
    size: integer("size").notNull(),
    mtime: real("mtime").notNull(),
    turns: integer("turns").notNull().default(0),
    ingested_at: text("ingested_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.store, table.path] })]
);

export type GrokFile = typeof grokFiles.$inferSelect;
export type NewGrokFile = typeof grokFiles.$inferInsert;

export const geminiEvents = sqliteTable(
  "gemini_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    store: text("store").notNull(),
    conversation_id: text("conversation_id").notNull(),

    gen_idx: integer("gen_idx").notNull(),

    ts: text("ts").notNull(),

    ts_basis: text("ts_basis").notNull(),
    model: text("model"),

    workspace: text("workspace"),
    path: text("path").notNull(),

    fresh_in: integer("fresh_in").notNull().default(0),

    cached_in: integer("cached_in").notNull().default(0),

    out_total: integer("out_total").notNull().default(0),
    out_thinking: integer("out_thinking").notNull().default(0),
    out_visible: integer("out_visible").notNull().default(0),

    context_tokens: integer("context_tokens").notNull().default(0),
    context_limit: integer("context_limit").notNull().default(0),

    usd: real("usd").notNull().default(0),

    project_id: text("project_id"),
  },
  (table) => [
    index("gemini_events_store_ts_idx").on(table.store, table.ts),
    index("gemini_events_ts_idx").on(table.ts),
    index("gemini_events_store_path_idx").on(table.store, table.path),
    index("gemini_events_model_idx").on(table.model),
    uniqueIndex("gemini_events_gen_unique").on(table.store, table.conversation_id, table.gen_idx),
  ]
);

export type GeminiEvent = typeof geminiEvents.$inferSelect;
export type NewGeminiEvent = typeof geminiEvents.$inferInsert;

export const geminiFiles = sqliteTable(
  "gemini_files",
  {
    store: text("store").notNull(),
    path: text("path").notNull(),
    size: integer("size").notNull(),
    mtime: real("mtime").notNull(),
    generations: integer("generations").notNull().default(0),
    ingested_at: text("ingested_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.store, table.path] })]
);

export type GeminiFile = typeof geminiFiles.$inferSelect;
export type NewGeminiFile = typeof geminiFiles.$inferInsert;

// Bookmark per gauge journal file in the archive (`gauges/<store>/<path>`).
// `offset` is how far the journal was read; the file is append-only, so the
// next ingest parses only the tail. A file shorter than its offset was
// rewritten and is read from the start again.
export const gaugeFiles = sqliteTable(
  "gauge_files",
  {
    store: text("store").notNull(),
    path: text("path").notNull(),
    size: integer("size").notNull(),
    mtime: real("mtime").notNull(),
    offset: integer("offset").notNull().default(0),
    rows: integer("rows").notNull().default(0),
    ingested_at: text("ingested_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.store, table.path] })]
);

export type GaugeFile = typeof gaugeFiles.$inferSelect;

export const syncRevisions = sqliteTable("sync_revisions", {
  id: integer("id").primaryKey(),
  data_revision: integer("data_revision").notNull().default(0),
  config_revision: integer("config_revision").notNull().default(0),
  config_fingerprint: text("config_fingerprint").notNull().default(""),
  updated_at: text("updated_at").notNull(),
});

export const vendorSyncRevisions = sqliteTable("vendor_sync_revisions", {
  vendor: text("vendor").primaryKey(),
  data_revision: integer("data_revision").notNull().default(0),
  updated_at: text("updated_at").notNull(),
});

export const syncRuns = sqliteTable(
  "sync_runs",
  {
    run_id: text("run_id").primaryKey(),
    trigger: text("trigger").notNull(),
    scope: text("scope").notNull(),
    vendor: text("vendor"),
    mode: text("mode").notNull(),
    status: text("status").notNull(),
    started_at: text("started_at").notNull(),
    finished_at: text("finished_at"),
    before_data_revision: integer("before_data_revision").notNull(),
    after_data_revision: integer("after_data_revision").notNull(),
    before_config_revision: integer("before_config_revision").notNull(),
    after_config_revision: integer("after_config_revision").notNull(),
    result_json: text("result_json"),
    error: text("error"),
  },
  (table) => [
    index("sync_runs_status_started_idx").on(table.status, table.started_at),
    uniqueIndex("sync_runs_one_running_idx")
      .on(table.status)
      .where(sql`${table.status} = 'running'`),
  ]
);

// P0/P1 projections. Mutation triggers and one-time backfill are maintained in migration 0021.
export const currentProjectionState = sqliteTable("current_projection_state", {
  id: integer("id").primaryKey(),
  schema_version: integer("schema_version").notNull().default(1),
  probe_revision: integer("probe_revision").notNull().default(0),
  published_probe_revision: integer("published_probe_revision").notNull().default(0),
  generation: integer("generation").notNull().default(0),
  config_fingerprint: text("config_fingerprint").notNull().default(""),
  generated_at: text("generated_at"),
  error_code: text("error_code"),
}, (table) => [check("current_projection_singleton", sql`${table.id} = 1`)]);
// Physical evidence of each limit reading, written once by the current projection (0058; `db/probe-sources.ts`).
export const probeSources = sqliteTable("probe_sources", {
  probe_id: integer("probe_id").notNull(), ord: integer("ord").notNull(), provider: text("provider").notNull(),
  machine: text("machine"), home: text("home"), login: text("login"), basis: text("basis").notNull(),
  tuples: integer("tuples").notNull(), at: integer("at"), accounting_at: integer("accounting_at"),
  observation_at: integer("observation_at"), subject: text("subject").notNull(),
  bare: integer("bare").notNull(), revision: integer("revision").notNull(),
}, (table) => [primaryKey({ columns: [table.probe_id, table.ord] }),
  index("probe_sources_tuple").on(table.provider, table.machine, table.home, table.login, table.at, table.probe_id),
  index("probe_sources_time").on(table.provider, table.at, table.probe_id),
  index("probe_sources_accounting").on(table.provider, table.machine, table.home, table.login, table.accounting_at, table.probe_id),
  index("probe_sources_observation").on(table.provider, table.machine, table.home, table.login, table.observation_at, table.probe_id),
  index("probe_sources_bare").on(table.provider, table.subject, table.at, table.probe_id).where(sql`bare = 1`)]);
export const probeSourceTuples = sqliteTable("probe_source_tuples", {
  provider: text("provider").notNull(), machine: text("machine").notNull(), home: text("home").notNull(), login: text("login").notNull(),
}, (table) => [primaryKey({ columns: [table.provider, table.machine, table.home, table.login] })]);
export const probeSourceDirty = sqliteTable("probe_source_dirty", {
  probe_id: integer("probe_id").primaryKey(), changed: integer("changed").notNull().default(0),
});
export const currentProjectionDirty = sqliteTable("current_projection_dirty", {
  provider: text("provider").notNull(), subject: text("subject").notNull(),
}, (table) => [primaryKey({ columns: [table.provider, table.subject] })]);
export const currentProbeSubjects = sqliteTable("current_probe_subjects", {
  provider: text("provider").notNull(), subject: text("subject").notNull(), data: text("data").notNull(),
  generated_at: text("generated_at").notNull(), next_refresh_at: text("next_refresh_at"),
}, (table) => [primaryKey({ columns: [table.provider, table.subject] })]);
export const subscriptionCurrent = sqliteTable("subscription_current", {
  id: text("id").primaryKey().notNull(), data: text("data").notNull(),
});
/** Event-time usage facts; prices from rate cards are applied when reading. */
/** Local operational queue; never copied into a distributable Atlas snapshot. */
export const gaugeJournalOutbox = sqliteTable("gauge_journal_outbox", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entry_id: text("entry_id").notNull(),
  journal_root: text("journal_root").notNull(),
  archive_root: text("archive_root"),
  file_name: text("file_name").notNull(),
  payload: text("payload").notNull(),
  queued_at: text("queued_at").notNull(),
}, table => [
  uniqueIndex("gauge_journal_entry_id").on(table.entry_id),
  index("gauge_journal_delivery").on(table.journal_root, table.archive_root, table.id),
]);
/** Transport receipts survive re-attribution; they do not assert canonical fact identity. */
export const gaugeJournalReceipts = sqliteTable("gauge_journal_receipts", {
  entry_id: text("entry_id").primaryKey().notNull(),
  payload_hash: text("payload_hash").notNull(),
  ts: text("ts").notNull(),
});

export const probeObservations = sqliteTable("probe_observations", { id: text("id").primaryKey(), header: text("header").notNull() });
export const probeCounters = sqliteTable("probe_counters", {
  id: text("id").primaryKey(), observation_id: text("observation_id").notNull().references(() => probeObservations.id),
  discriminator: text("discriminator").notNull(), payload: text("payload").notNull(), payload_digest: text("payload_digest").notNull(),
}, table => [uniqueIndex("probe_counter_discriminator").on(table.observation_id, table.discriminator)]);
export const probeFactDeliveries = sqliteTable("probe_fact_deliveries", {
  id: text("id").primaryKey(), counter_id: text("counter_id").notNull().references(() => probeCounters.id), evidence: text("evidence").notNull(),
});
export const probeFactLegacyMap = sqliteTable("probe_fact_legacy_map", {
  id: text("id").primaryKey(), namespace: text("namespace").notNull(), legacy_id: integer("legacy_id"),
  evidence_hash: text("evidence_hash").notNull(), counter_id: text("counter_id").notNull().references(() => probeCounters.id), reason: text("reason").notNull(),
}, table => [index("probe_fact_legacy_pointer").on(table.namespace, table.legacy_id),
  index("probe_fact_counter_mapping").on(table.counter_id, table.namespace, table.legacy_id)]);
export const probeFactConflicts = sqliteTable("probe_fact_conflicts", {
  id: text("id").primaryKey(), family: text("family").notNull(), reason: text("reason").notNull(),
  existing_payload: text("existing_payload").notNull(), candidate_payload: text("candidate_payload").notNull(),
});
export const probeFactBackfillCheckpoints = sqliteTable("probe_fact_backfill_checkpoints", {
  id: text("id").primaryKey(), namespace: text("namespace").notNull(), cursor: integer("cursor").notNull(), evidence_hash: text("evidence_hash").notNull(),
});

export const analysisSourceRevisions = sqliteTable("analysis_source_revisions", {
  source: text("source").notNull(), bucket: text("bucket").notNull(), revision: integer("revision").notNull(),
}, table => [primaryKey({ columns: [table.source, table.bucket] })]);
