-- OpenCode-other calls chain per session and home (their owner): two homes never bridge each other's gaps
-- (docs/stored-activity-plan-2026-10-07.md, review of 07.10). Every session with OpenCode-other calls is queued for the
-- producer's regap; it rewrites only gaps and mixed-session entries that change and re-sums only their days.
INSERT OR IGNORE INTO usage_ledger_dirty(provider, kind, value)
  SELECT DISTINCT 'glm', 'session', session FROM usage_ledger_facts
  WHERE provider='glm' AND session IS NOT NULL AND copy_state='canonical' AND eligible=0;
