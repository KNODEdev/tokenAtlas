CREATE TABLE IF NOT EXISTS subscription_fact_scopes (
  scope TEXT PRIMARY KEY, provider TEXT NOT NULL, account TEXT NOT NULL,
  source TEXT NOT NULL, cursor INTEGER NOT NULL, bookmark INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('backfill','replay','ready'))
);
CREATE TABLE IF NOT EXISTS subscription_fact_versions (
  scope TEXT NOT NULL, source_key TEXT NOT NULL, valid_from INTEGER NOT NULL,
  valid_until INTEGER, identity TEXT NOT NULL, ts TEXT NOT NULL,
  fingerprint TEXT NOT NULL, project TEXT, payload TEXT NOT NULL,
  PRIMARY KEY(scope,source_key,valid_from)
);
CREATE INDEX IF NOT EXISTS subscription_fact_time ON subscription_fact_versions(scope,ts,valid_from,valid_until);
CREATE INDEX IF NOT EXISTS subscription_fact_identity ON subscription_fact_versions(scope,identity,valid_from,valid_until);