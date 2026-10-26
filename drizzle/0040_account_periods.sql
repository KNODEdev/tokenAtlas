-- Account and plan periods (docs/account-periods-model-2026-09-21.md).
--
-- An event and a sum know their source and their time, never an account. "Which account was
-- logged in at this source" and "which plan did this account have" are dated rows here, so
-- correcting a date edits a row instead of restamping events and rebuilding sums.
--
-- `source` is the archive folder of one profile on one computer (`claude/MOVEAR-MAIN`), the only
-- source identity an event carries. `from_ts` is inclusive, `until_ts` exclusive and NULL while
-- the period continues; both are ISO instants, or a YYYY-MM-DD day meaning its UTC midnight.
-- `origin` is `observed` (built from profile readings) or `declared` (the owner's correction,
-- which wins inside its range while the observed row stays as evidence).
CREATE TABLE IF NOT EXISTS account_periods (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  source TEXT NOT NULL,
  from_ts TEXT NOT NULL,
  until_ts TEXT,
  account TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('observed', 'declared')),
  first_seen TEXT,
  last_seen TEXT,
  readings INTEGER NOT NULL DEFAULT 0,
  evidence TEXT NOT NULL,
  UNIQUE (provider, source, origin, from_ts)
);
--> statement-breakpoint
-- The plan is a period of the account, not a trait: one account went 5x, 20x and 5x again
-- within six weeks. `plan` is the provider's own label; there is no closed list.
-- `amount_minor` is the paid amount in the currency's minor unit, when a receipt states it.
CREATE TABLE IF NOT EXISTS plan_periods (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  account TEXT NOT NULL,
  from_ts TEXT NOT NULL,
  until_ts TEXT,
  plan TEXT NOT NULL,
  amount_minor INTEGER,
  currency TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('observed', 'declared')),
  first_seen TEXT,
  last_seen TEXT,
  readings INTEGER NOT NULL DEFAULT 0,
  evidence TEXT NOT NULL,
  UNIQUE (provider, account, origin, from_ts)
);
