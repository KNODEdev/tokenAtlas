-- The actual-mode rate key of a usage-ledger day row (docs/stored-activity-plan-2026-10-07.md step 8): the project cost
-- report splits a row's priced amount by token type as its bucket sums times that key's stored rates, without reading its
-- calls. A key is chosen per model, mode and UTC day, all three fixed for a row, so a row's eligible canonical calls share
-- one; NULL marks a row without such calls or (never by construction) with several, which readers take from its facts.
-- Filled here from the facts in one pass; the producer keeps it with every day it rebuilds.
ALTER TABLE usage_ledger_days ADD COLUMN act_key INTEGER;
--> statement-breakpoint
UPDATE usage_ledger_days AS d SET act_key=k.act_key
  FROM (SELECT provider, day, dim_id, CASE WHEN COUNT(DISTINCT act_key)=1 AND COUNT(act_key)=COUNT(*) THEN MIN(act_key) END act_key
    FROM usage_ledger_facts WHERE copy_state='canonical' AND accounting=1 AND eligible=1 AND dim_id IS NOT NULL
    GROUP BY provider, day, dim_id) k
  WHERE d.provider=k.provider AND d.day=k.day AND d.dim_id=k.dim_id;
