-- Limit windows (plan U1.1): the stored result of the probe-limit segmentation for every provider,
-- account and counter, maintained incrementally by the analysis maintenance worker.
-- limit_windows: one row per window, in segmentation order (seq), with the segmenter state needed to resume.
CREATE TABLE IF NOT EXISTS limit_windows (
  provider TEXT NOT NULL, account TEXT NOT NULL, counter TEXT NOT NULL, seq INTEGER NOT NULL,
  window_id TEXT NOT NULL, start_ts TEXT NOT NULL, end_ts TEXT NOT NULL, reset_ts TEXT NOT NULL,
  cycle_end_basis TEXT NOT NULL, window_minutes INTEGER NOT NULL,
  plan TEXT, plan_detail TEXT, plan_mismatch INTEGER NOT NULL,
  readings TEXT NOT NULL, manual TEXT, start_drop TEXT, end_drop TEXT,
  seen_reset INTEGER NOT NULL, last_input TEXT NOT NULL,
  PRIMARY KEY(provider, account, counter, seq)
) STRICT;
--> statement-breakpoint
-- limit_window_inputs: the segmentation input of each counter (reconciled readings), the saved producer
-- state from which a changed region is recomputed and segmentation resumes. Equal times are ordered by
-- grp (the Codex reading group's creation key) and ord, as the segmenter consumes them. anchor: region key (ms).
CREATE TABLE IF NOT EXISTS limit_window_inputs (
  provider TEXT NOT NULL, account TEXT NOT NULL, scope TEXT NOT NULL, counter TEXT NOT NULL,
  ts TEXT NOT NULL, grp TEXT NOT NULL, ord INTEGER NOT NULL, used_percent REAL NOT NULL, resets_at TEXT NOT NULL,
  window_minutes INTEGER NOT NULL, source TEXT NOT NULL, limit_hit TEXT, anchor INTEGER NOT NULL,
  home TEXT, path TEXT,
  PRIMARY KEY(provider, account, scope, counter, ts, grp, ord)
) STRICT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS limit_window_inputs_anchor ON limit_window_inputs(provider, account, scope, anchor);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS limit_window_inputs_file ON limit_window_inputs(home, path) WHERE home IS NOT NULL;
--> statement-breakpoint
-- limit_window_state: one producer scope per account (Codex: per counter), its progress and bounds.
CREATE TABLE IF NOT EXISTS limit_window_state (
  provider TEXT NOT NULL, account TEXT NOT NULL, scope TEXT NOT NULL,
  version INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('filling','ready')),
  lead_max INTEGER, lead_min INTEGER, inputs_from INTEGER, changed_from INTEGER, resolve INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(provider, account, scope)
) STRICT;
--> statement-breakpoint
-- limit_window_dirty: entries written by the writer that changed an input, in its own transaction.
CREATE TABLE IF NOT EXISTS limit_window_dirty (
  provider TEXT NOT NULL, account TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('inputs','resolve','file')),
  from_ms INTEGER NOT NULL, sequence INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(provider, account, kind)
) STRICT;
