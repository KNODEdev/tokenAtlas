-- Credit notices (docs/credit-notices-2026-10-09.md): what a subscription received, spent or will lose of its
-- extras, maintained by the background job `credit-notices` from the published current cards.
-- credit_pool_cursor: per account, the published card and the pool reading last folded.
CREATE TABLE IF NOT EXISTS credit_pool_cursor (
  provider TEXT NOT NULL, account TEXT NOT NULL, card_at TEXT NOT NULL, reading_id INTEGER, read_at TEXT,
  PRIMARY KEY(provider, account)
) STRICT;
--> statement-breakpoint
-- credit_pool_state: per account and pool identity, the last state and the first observation (pace).
CREATE TABLE IF NOT EXISTS credit_pool_state (
  provider TEXT NOT NULL, account TEXT NOT NULL, identity TEXT NOT NULL, state TEXT NOT NULL, read_at TEXT NOT NULL,
  baseline_at TEXT NOT NULL, baseline_used REAL,
  PRIMARY KEY(provider, account, identity)
) STRICT;
--> statement-breakpoint
-- credit_notices: one row per notice identity; replays and refolds write the same rows again.
CREATE TABLE IF NOT EXISTS credit_notices (
  id INTEGER PRIMARY KEY, provider TEXT NOT NULL, account TEXT NOT NULL, notice TEXT NOT NULL, pool TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('received','topped_up','used','spent','expiring','expired_unused')),
  unit TEXT NOT NULL, amount REAL, amount_text TEXT, expires_at TEXT, observed_at TEXT NOT NULL, detail TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT, acknowledged_at TEXT,
  UNIQUE(provider, account, notice)
) STRICT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS credit_notices_open ON credit_notices(observed_at) WHERE acknowledged_at IS NULL AND resolved_at IS NULL;
