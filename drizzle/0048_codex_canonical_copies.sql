-- U3.1: duplicate copies of one Codex call are resolved when the ledger is built (identity, copy state),
-- so sums hold only canonical calls. Existing facts are kept; the background producer resolves every
-- conversation and rebuilds every day's sums from them (no source re-import).
ALTER TABLE codex_price_ledger_events ADD COLUMN identity TEXT;
--> statement-breakpoint
ALTER TABLE codex_price_ledger_events ADD COLUMN copy_state TEXT NOT NULL DEFAULT 'pending' CHECK(copy_state IN ('pending','canonical','duplicate','conflict'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS codex_price_ledger_events_identity ON codex_price_ledger_events(identity) WHERE identity IS NOT NULL;
--> statement-breakpoint
ALTER TABLE codex_price_ledger_copies ADD COLUMN relative_path TEXT;
--> statement-breakpoint
ALTER TABLE codex_price_ledger_copies ADD COLUMN conversation TEXT;
--> statement-breakpoint
UPDATE codex_price_ledger_copies SET relative_path=COALESCE((SELECT i.relative_path FROM codex_ledger_copies i WHERE i.id=codex_price_ledger_copies.identity),path);
--> statement-breakpoint
UPDATE codex_price_ledger_copies SET conversation=lower(COALESCE(source,home,''))||'|'||lower(substr(replace(relative_path,char(92),'/'),
    length(rtrim(replace(relative_path,char(92),'/'),replace(replace(relative_path,char(92),'/'),'/','')))+1))
  WHERE relative_path IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS codex_price_ledger_copies_conversation ON codex_price_ledger_copies(conversation);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS codex_ledger_dirty (
  kind TEXT NOT NULL CHECK(kind IN ('conversation','day')),value TEXT NOT NULL,PRIMARY KEY(kind,value)
) STRICT;
--> statement-breakpoint
INSERT OR IGNORE INTO codex_ledger_dirty(kind,value) SELECT DISTINCT 'conversation',conversation FROM codex_price_ledger_copies WHERE conversation IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO codex_ledger_dirty(kind,value) SELECT DISTINCT 'day',day FROM codex_price_ledger_events;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_price_ledger_aggregates;
--> statement-breakpoint
CREATE TABLE codex_price_ledger_aggregates(grain TEXT NOT NULL,day TEXT NOT NULL,hour INTEGER NOT NULL,dim_id INTEGER NOT NULL,
      api_band INTEGER NOT NULL,credit_band INTEGER NOT NULL,api_reason TEXT NOT NULL,credit_reason TEXT NOT NULL,
      api_zero INTEGER NOT NULL,credit_zero INTEGER NOT NULL,copy_state TEXT NOT NULL,calls INTEGER NOT NULL,first_ts TEXT NOT NULL,last_ts TEXT NOT NULL,
      reported INTEGER NOT NULL,uncached INTEGER NOT NULL,cached INTEGER NOT NULL,writes INTEGER NOT NULL,
      output INTEGER NOT NULL,reasoning INTEGER NOT NULL,window_input INTEGER NOT NULL,window_cached INTEGER NOT NULL,
      window_output INTEGER NOT NULL,invalid_tokens INTEGER NOT NULL,
      api_whole_hi INTEGER,api_whole_lo INTEGER,api_fraction_hi INTEGER,api_fraction_lo INTEGER,
      credit_whole_hi INTEGER,credit_whole_lo INTEGER,credit_fraction_hi INTEGER,credit_fraction_lo INTEGER,
      PRIMARY KEY(grain,day,hour,dim_id,api_band,credit_band,api_reason,credit_reason,api_zero,credit_zero,copy_state)) STRICT;
--> statement-breakpoint
CREATE INDEX codex_price_ledger_aggregates_day ON codex_price_ledger_aggregates(grain,day,dim_id);
--> statement-breakpoint
UPDATE codex_price_ledger_state SET status='building';
