-- Codex accounting reads stored rows: the Spark/main evidence of each rollout file (and meter reset) was read from
-- every ledger call of the range on each request. The ledger now keeps, beside its copy-free sums, which files a
-- dimension's calls came from per calendar hour (first and last instant). It is filled here from the calls the
-- ledger has published (admitted, copy resolved) and kept with the sums from then on. No source re-import.
CREATE TABLE codex_price_ledger_file_models(hour INTEGER NOT NULL,dim_id INTEGER NOT NULL,day TEXT NOT NULL,
      copy_id INTEGER NOT NULL,first_ms INTEGER NOT NULL,last_ms INTEGER NOT NULL,PRIMARY KEY(hour,dim_id,day,copy_id)) STRICT;
--> statement-breakpoint
CREATE INDEX codex_price_ledger_file_models_day ON codex_price_ledger_file_models(day,dim_id);
--> statement-breakpoint
INSERT INTO codex_price_ledger_file_models(hour,dim_id,day,copy_id,first_ms,last_ms)
  SELECT CAST(floor(instant_ms/3600000.0) AS INTEGER) hour,dim_id,day,copy_id,MIN(instant_ms),MAX(instant_ms)
  FROM codex_price_ledger_events WHERE admitted=1 AND copy_state<>'pending' AND instant_ms IS NOT NULL
  GROUP BY hour,dim_id,day,copy_id;
