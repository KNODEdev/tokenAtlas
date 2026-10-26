-- Counter windows from register sums (register version 7).
--
-- A window pairs traffic with one counter: it leaves out events that declare another reset or
-- another plan, counts tokens under its own validity rule and prices one joint cohort. None of
-- that can be recovered from the sums of 0038, so the contribution records the event's plan and
-- its window tokens, and a bucket is keyed by the reset and the plan as well.
--
-- Nothing is priced again: version 7 rebuilds every contribution from `event_valuations`.
-- Rows of the superseded scopes keep the defaults until the producer retires them.
ALTER TABLE usage_price_contributions ADD COLUMN plan_type TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
-- `[input, cached, output]` without trailing zeros; empty when the window counts no tokens.
ALTER TABLE usage_price_contributions ADD COLUMN window_tokens TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
DROP TABLE IF EXISTS usage_price_copy_buckets;
--> statement-breakpoint
-- `meter_reset` is the recorded value, -1 for none: readings of one reset differ by seconds and
-- a window accepts 120 s either way, so rounding here could part values a window keeps together.
-- `first_ts`/`last_ts` are the instants a window reports as a source's first and last event.
CREATE TABLE usage_price_copy_buckets (
  scope TEXT NOT NULL,
  day TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  copy TEXT NOT NULL,
  dim TEXT NOT NULL,
  meter_reset INTEGER NOT NULL,
  plan_type TEXT NOT NULL,
  calls INTEGER NOT NULL,
  tokens_reported TEXT NOT NULL,
  counts TEXT NOT NULL,
  window_tokens TEXT NOT NULL,
  first_ts TEXT NOT NULL,
  last_ts TEXT NOT NULL,
  PRIMARY KEY (scope, day, bucket, copy, dim, meter_reset, plan_type)
) WITHOUT ROWID;
--> statement-breakpoint
DELETE FROM usage_price_bucket_state;
