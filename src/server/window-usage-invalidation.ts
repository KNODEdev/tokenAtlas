import type { Database } from "bun:sqlite";
import { usageProviderIds } from "./subscription-accounting-adapters";
import type { ReferencePlan, WindowUsageProducerOptions, WindowInterval } from "./window-usage-contracts";
import { metaValue, digest } from "./window-usage-meta";
import type { ClaudeGaugeConfig } from "./claude-gauge";
import { CLAUDE_CODE_PRODUCT_RULE } from "../shared/claude-code-capacity";
import { MODEL_CAPACITY_VERSION } from "../shared/model-capacity";
import { markWindowUsageDirty, WINDOW_USAGE_ALL, WINDOW_USAGE_BEGINNING } from "../db/window-usage";
import { WINDOW_USAGE_VERSION, CODEX_WINDOW_UNITS_RULE, CODEX_WINDOW_CONTEXT_RULE, CLAUDE_WINDOW_CONTEXT_RULE, CLAUDE_WINDOW_FUNDING_RULE, intervalOverlaps, intervalKey } from "./window-usage-contracts";
import { claudeScopeModels } from "./window-usage-values";
import { bumpWindowUsageClocks } from "./window-usage-clock";

/**
 * Stored rows of a provider whose variant is missing or values other rates are computed again, when the
 * provider's valuation changes (other rates, or Codex's valuation becoming ready); a turn with the same
 * valuation checks nothing. The fingerprint is matched in the variant's leading `{"day":…,"fingerprint":…`
 * text, never by parsing every stored variant.
 */
const referenceKey = (provider: string) => `window_usage_reference_${provider}`;

/** Whether some provider's valuation differs from the one its stored rows were queued for (read without the writer). */
export function referenceVariantsChanged(db: Database, plan: ReferencePlan): boolean {
  return usageProviderIds().some(provider => metaValue(db, referenceKey(provider)) !== (plan(provider)?.fingerprint ?? "none"));
}

export function enqueueReferenceVariants(db: Database, plan: ReferencePlan): void {
  for (const provider of usageProviderIds()) {
    const variant = plan(provider), key = referenceKey(provider), state = variant?.fingerprint ?? "none";
    if (metaValue(db, key) === state) continue;
    if (variant) db.query(`INSERT OR IGNORE INTO window_usage_pending(provider,account,counter,window_id)
      SELECT provider,account,counter,window_id FROM window_usage
      WHERE provider=? AND (reference IS NULL OR instr(substr(reference,1,160),?)=0)`).run(provider, `"fingerprint":"${variant.fingerprint}"`);
    db.query("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, state);
  }
}

/**
 * Inputs without a database writer: the definition version, the identity declarations owners follow,
 * the models of the Claude scoped sublimit (they split the Claude rail) and the Claude Code product rule.
 */
export function enqueueConfigChanges(db: Database, options: WindowUsageProducerOptions, gauge: ClaudeGaugeConfig): void {
  const checks: Array<[string, string, readonly string[]]> = [["window_usage_version", String(WINDOW_USAGE_VERSION), usageProviderIds()],
    ["window_usage_resolver", digest(options.subscriptions ?? []), usageProviderIds()],
    ["window_usage_claude_scope", digest(claudeScopeModels(gauge)), ["claude"]],
    // The Code share of Claude windows counts facts by this rule; a new rule re-sums Claude windows only.
    ["window_usage_claude_product", CLAUDE_CODE_PRODUCT_RULE, ["claude"]],
    // The Codex rail's credits, sums at the limit and credit-funded calls; a new rule re-sums Codex windows only.
    ["window_usage_codex_units", CODEX_WINDOW_UNITS_RULE, ["codex"]],
    ["window_usage_codex_context", CODEX_WINDOW_CONTEXT_RULE, ["codex"]],
    ["window_usage_claude_context", CLAUDE_WINDOW_CONTEXT_RULE, ["claude"]],
    ["window_usage_claude_funding", CLAUDE_WINDOW_FUNDING_RULE, ["claude"]],
    ["window_usage_model_capacity", String(MODEL_CAPACITY_VERSION), ["codex", "claude"]]];
  const stale = checks.filter(([key, value]) => metaValue(db, key) !== value);
  if (!stale.length) return;
  db.transaction(() => {
    for (const provider of new Set(stale.flatMap(([, , providers]) => providers)))
      markWindowUsageDirty(db, { provider, account: WINDOW_USAGE_ALL, fromMs: WINDOW_USAGE_BEGINNING });
    for (const [key, value] of stale) db.query("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }).immediate();
}

type WindowKey = { provider: string; account: string; counter: string; window_id: string; start_ts: string; end_ts: string };

const overlaps = (row: Pick<WindowKey, "start_ts" | "end_ts">, from: number, until: number | null) =>
  Date.parse(row.end_ts) > from && (until === null || Date.parse(row.start_ts) < until);

/**
 * Turns writer entries into pending windows and intervals, and drops rows of windows that no longer
 * exist, atomically per entry. Window changes name their counter; ledger and period changes (every
 * counter) also reach the intervals of their span.
 */
export function applyDirty(db: Database, intervals: ReadonlyMap<string, WindowInterval>): void {
  const entries = db.query("SELECT provider,account,counter,from_ms,until_ms,sequence FROM window_usage_dirty").all() as
    Array<{ provider: string; account: string; counter: string; from_ms: number; until_ms: number | null; sequence: number }>;
  if (!entries.length) return;
  db.transaction(() => {
    for (const entry of entries) {
      const where = ["provider=?"], params: string[] = [entry.provider];
      if (entry.account !== WINDOW_USAGE_ALL) { where.push("account=?"); params.push(entry.account); }
      if (entry.counter !== WINDOW_USAGE_ALL) { where.push("counter=?"); params.push(entry.counter); }
      const windows = (db.query(`SELECT provider,account,counter,window_id,start_ts,end_ts FROM limit_windows WHERE ${where.join(" AND ")}`)
        .all(...params) as WindowKey[]).filter(row => overlaps(row, entry.from_ms, entry.until_ms));
      const pending = db.query("INSERT OR IGNORE INTO window_usage_pending(provider,account,counter,window_id) VALUES(?,?,?,?)");
      for (const row of windows) pending.run(row.provider, row.account, row.counter, row.window_id);
      // A reconstructed window also reports traffic no account owns, which another account's period change can claim.
      if (entry.counter === WINDOW_USAGE_ALL) for (const interval of intervals.values())
        if (interval.provider === entry.provider && (entry.account === WINDOW_USAGE_ALL || interval.account === entry.account
          || interval.kind === "declared") && intervalOverlaps(interval, entry.from_ms, entry.until_ms))
          pending.run(interval.provider, interval.account, interval.counter, interval.id);
      const current = new Set(windows.map(row => JSON.stringify([row.account, row.counter, row.window_id])));
      const remove = db.query("DELETE FROM window_usage WHERE provider=? AND account=? AND counter=? AND window_id=?");
      for (const row of db.query(`SELECT provider,account,counter,window_id,start_ts,end_ts FROM window_usage WHERE ${where.join(" AND ")}`)
        .all(...params) as WindowKey[])
        if (overlaps(row, entry.from_ms, entry.until_ms) && !current.has(JSON.stringify([row.account, row.counter, row.window_id]))
          && !intervals.has(intervalKey(row.provider, row.account, row.counter, row.window_id))) {
          remove.run(row.provider, row.account, row.counter, row.window_id);
          bumpWindowUsageClocks(db, row.provider, row.account);
        }
      db.query("DELETE FROM window_usage_dirty WHERE provider=? AND account=? AND counter=? AND from_ms=? AND sequence=?")
        .run(entry.provider, entry.account, entry.counter, entry.from_ms, entry.sequence);
    }
  }).immediate();
}
