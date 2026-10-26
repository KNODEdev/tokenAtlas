/** Historical subject-keyed SQL oracle retained for comparison tooling.
 * Production reads use the prepared source/account index above.
 */
export const LATEST_ACCOUNT_STATE_SQL = `WITH subjects AS MATERIALIZED (
  SELECT DISTINCT subject FROM probe_windows WHERE provider = 'codex'
), newest AS MATERIALIZED (
  SELECT subject, (
    SELECT ts FROM probe_windows p
    WHERE p.provider = 'codex' AND p.subject = subjects.subject
      AND p.kind <> 'error' AND COALESCE(p.ok, 1) = 1
      AND COALESCE(p.era_unattributed, 0) = 0
    ORDER BY p.ts DESC LIMIT 1
  ) AS ts FROM subjects
)
SELECT p.subject AS account, p.limit_group AS limit_id, p.scope AS limit_name,
       p.plan AS plan_type, p.kind AS slot, p.window_minutes,
       p.used_percent, p.resets_at, p.rate_limit_reached, p.reset_credits, p.ts, p.machine
FROM newest CROSS JOIN probe_windows p ON p.provider = 'codex' AND p.subject = newest.subject AND p.ts = newest.ts
WHERE p.kind <> 'error' AND COALESCE(p.era_unattributed, 0) = 0
ORDER BY p.subject, p.limit_group, p.kind`;
