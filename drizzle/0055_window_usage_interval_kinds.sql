-- Window usage intervals (plan U1.4) gain Grok's fallback spans: a rolling span up to and including an account's
-- newest call ('rolling') and the anchored period of that call ('anchored'), kept beside its gauge observations
-- ('gauge') so the Grok gauge reads stored sums. SQLite cannot widen a CHECK, so the table is rebuilt with its rows;
-- the producer republishes the list from its inputs on its next turn either way.
CREATE TABLE window_usage_intervals_next (
  provider TEXT NOT NULL, account TEXT NOT NULL, counter TEXT NOT NULL, window_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('manual','gauge','declared','rolling','anchored')), start_ts TEXT NOT NULL, end_ts TEXT NOT NULL, spec TEXT NOT NULL,
  PRIMARY KEY(provider, account, counter, window_id)
) STRICT;
--> statement-breakpoint
INSERT INTO window_usage_intervals_next(provider,account,counter,window_id,kind,start_ts,end_ts,spec)
  SELECT provider,account,counter,window_id,kind,start_ts,end_ts,spec FROM window_usage_intervals;
--> statement-breakpoint
DROP TABLE window_usage_intervals;
--> statement-breakpoint
ALTER TABLE window_usage_intervals_next RENAME TO window_usage_intervals;
