-- Stored activity for the Codex price ledger (docs/stored-activity-plan-2026-10-07.md, step 4): each call keeps its gap to
-- the previous canonical admitted call of its chain (one physical copy, ordinary or business credits; order instant,
-- offset) and that call's instant; each day-grain cohort keeps per idle cutoff the sum of min(gap, cutoff) over its
-- canonical calls' positive gaps (integer ms) and the earliest predecessor instant of those gaps. New columns only: nothing
-- is recomputed here. The producer fills them: every copy with calls is queued (kind `session`, value its copy id) and
-- every day with sums (kind `activity`, an in-place re-sum of these columns alone); `activity_published` on the `codex`
-- state row stays 0 until that work is done.
ALTER TABLE codex_price_ledger_events ADD COLUMN gap_ms INTEGER;
--> statement-breakpoint
ALTER TABLE codex_price_ledger_events ADD COLUMN gap_from_ms INTEGER;
--> statement-breakpoint
ALTER TABLE codex_price_ledger_aggregates ADD COLUMN active_5m_ms INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE codex_price_ledger_aggregates ADD COLUMN active_10m_ms INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE codex_price_ledger_aggregates ADD COLUMN active_15m_ms INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE codex_price_ledger_aggregates ADD COLUMN active_30m_ms INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE codex_price_ledger_aggregates ADD COLUMN active_45m_ms INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE codex_price_ledger_aggregates ADD COLUMN active_60m_ms INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE codex_price_ledger_aggregates ADD COLUMN gap_from_ms INTEGER;
--> statement-breakpoint
INSERT OR IGNORE INTO usage_ledger_dirty(provider,kind,value)
  SELECT 'codex','session',CAST(id AS TEXT) FROM codex_price_ledger_copies c
  WHERE EXISTS(SELECT 1 FROM codex_price_ledger_events e WHERE e.copy_id=c.id);
--> statement-breakpoint
INSERT OR IGNORE INTO usage_ledger_dirty(provider,kind,value)
  SELECT DISTINCT 'codex','activity',day FROM codex_price_ledger_aggregates WHERE grain='day';
