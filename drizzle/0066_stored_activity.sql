-- Stored activity, M1 (docs/stored-activity-plan-2026-10-07.md): each usage-ledger fact keeps its gap to the previous
-- canonical call of its chain (session, source, account key, class) and that call's instant; each day row keeps per
-- idle cutoff the sum of min(gap, cutoff) over its calls' positive gaps (integer ms), the earliest predecessor instant
-- of those gaps and its calls whose source day differs from their UTC day. New columns only (nullable or defaulted): no
-- fact, valuation or token sum changes here and nothing is recomputed in the migration. The background producer fills
-- them: every session is queued (kind `session`) and every day row (kind `activity`, an in-place re-sum of these columns
-- alone), and `activity_published` stays 0 until that work is done, so activity readers answer "preparing" meanwhile.
ALTER TABLE usage_ledger_facts ADD COLUMN gap_ms INTEGER;
--> statement-breakpoint
ALTER TABLE usage_ledger_facts ADD COLUMN gap_from TEXT;
--> statement-breakpoint
ALTER TABLE usage_ledger_days ADD COLUMN active_5m_ms INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE usage_ledger_days ADD COLUMN active_10m_ms INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE usage_ledger_days ADD COLUMN active_15m_ms INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE usage_ledger_days ADD COLUMN active_30m_ms INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE usage_ledger_days ADD COLUMN active_45m_ms INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE usage_ledger_days ADD COLUMN active_60m_ms INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE usage_ledger_days ADD COLUMN gap_from_ts TEXT;
--> statement-breakpoint
ALTER TABLE usage_ledger_days ADD COLUMN src_shift_calls INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE usage_ledger_state ADD COLUMN activity_published INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
-- The queue's kind check gains `session` and `activity`: SQLite cannot alter a check, so the small table is recreated
-- with its rows, as 0062 did.
ALTER TABLE usage_ledger_dirty RENAME TO usage_ledger_dirty_before_0066;
--> statement-breakpoint
CREATE TABLE usage_ledger_dirty (
  provider TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('identity','day','copy','blocked','rules','session','activity')), value TEXT NOT NULL,
  PRIMARY KEY(provider, kind, value)
) STRICT;
--> statement-breakpoint
INSERT INTO usage_ledger_dirty(provider,kind,value) SELECT provider,kind,value FROM usage_ledger_dirty_before_0066;
--> statement-breakpoint
DROP TABLE usage_ledger_dirty_before_0066;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS usage_ledger_mixed_sessions (
  provider TEXT NOT NULL, session TEXT NOT NULL,
  PRIMARY KEY(provider, session)
) STRICT;
--> statement-breakpoint
-- Per provider, as usageLedgerFactIndexes builds them; a provider registered later gets its own from the producer.
CREATE INDEX IF NOT EXISTS usage_ledger_facts_session_claude ON usage_ledger_facts(session, ts) WHERE provider='claude';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_ledger_facts_session_gemini ON usage_ledger_facts(session, ts) WHERE provider='gemini';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_ledger_facts_session_grok ON usage_ledger_facts(session, ts) WHERE provider='grok';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_ledger_facts_session_glm ON usage_ledger_facts(session, ts) WHERE provider='glm';
--> statement-breakpoint
-- Every session with a fact, read from the session indexes, and every day row of the shared ledger (the Codex price
-- ledger keeps its own sums and is queued with its own producer's work).
INSERT OR IGNORE INTO usage_ledger_dirty(provider,kind,value)
  SELECT DISTINCT 'claude','session',session FROM usage_ledger_facts WHERE provider='claude' AND session IS NOT NULL AND session<>'';
--> statement-breakpoint
INSERT OR IGNORE INTO usage_ledger_dirty(provider,kind,value)
  SELECT DISTINCT 'gemini','session',session FROM usage_ledger_facts WHERE provider='gemini' AND session IS NOT NULL AND session<>'';
--> statement-breakpoint
INSERT OR IGNORE INTO usage_ledger_dirty(provider,kind,value)
  SELECT DISTINCT 'grok','session',session FROM usage_ledger_facts WHERE provider='grok' AND session IS NOT NULL AND session<>'';
--> statement-breakpoint
INSERT OR IGNORE INTO usage_ledger_dirty(provider,kind,value)
  SELECT DISTINCT 'glm','session',session FROM usage_ledger_facts WHERE provider='glm' AND session IS NOT NULL AND session<>'';
--> statement-breakpoint
INSERT OR IGNORE INTO usage_ledger_dirty(provider,kind,value)
  SELECT DISTINCT provider,'activity',day FROM usage_ledger_days WHERE provider<>'codex';
