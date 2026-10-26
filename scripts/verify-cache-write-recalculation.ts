import { Database } from "../src/db/sqlite";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { configFile } from "../src/config/paths";
import { resolveDbPath } from "../src/db";
import { prepareCodexPricing, resolveCodexAccountingConfig, priceCodexEvent, type CodexAccountingEvent } from "../src/server/codex-accounting-pricing";
import { subscriptionDailyUsage } from "../src/server/subscription-usage";
import type { RateCard } from "../src/server/pricing";

const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
const output = args.includes("--out") ? option("--out")! : null;
const dbPath = resolveDbPath(args.includes("--db") ? option("--db") : undefined);
const sqlite = new Database(dbPath, { readonly: true });
try {
  const cardPath = configFile("rate-cards.json");
  const bytes = fs.readFileSync(cardPath);
  const card = JSON.parse(bytes.toString("utf8")) as RateCard;
  const pricing = prepareCodexPricing(resolveCodexAccountingConfig(card));
  const totals = { events: 0, input: 0, cache_read: 0, cache_write: 0, output: 0 };
  const reference = { priced_usd: 0, unpriced_events: 0, reasons: {} as Record<string, number> };
  for (const e of sqlite.query("SELECT ts,model,speed,in_tok,cached_in,cache_write,out_tok,cache_write_status,usage_status FROM events").iterate() as Iterable<CodexAccountingEvent>) {
    totals.events++; totals.input += e.in_tok; totals.cache_read += e.cached_in; totals.cache_write += e.cache_write; totals.output += e.out_tok;
    const price = priceCodexEvent(pricing, { ...e, speed: "standard" }, "api_equivalent_usd");
    if (price.amount === null) { reference.unpriced_events++; reference.reasons[price.reason!] = (reference.reasons[price.reason!] ?? 0) + 1; }
    else reference.priced_usd += price.amount;
  }
  const frozen = JSON.parse(fs.readFileSync("docs/verification/cache-write-current-conversation-2026-09-13.json", "utf8"));
  const prefix = fs.readFileSync(frozen.source).subarray(0, frozen.source_prefix_bytes);
  const thread = sqlite.query("SELECT * FROM events WHERE path LIKE ? AND ts <= ? ORDER BY ts").all("%01a09983-6ea6-7640-b35b-207aff90a614.jsonl", frozen.cutoff_utc) as CodexAccountingEvent[];
  const sample = { events: thread.length, total_tokens: 0, standard_api_usd: 0, actual_known_api_usd: 0, unknown_mode_events: 0, writes: 0 };
  for (const e of thread) {
    sample.total_tokens += e.in_tok + e.out_tok; sample.writes += e.cache_write;
    sample.standard_api_usd += priceCodexEvent(pricing, { ...e, speed: "standard" }, "api_equivalent_usd").amount ?? 0;
    const actual = priceCodexEvent(pricing, e, "api_equivalent_usd");
    sample.actual_known_api_usd += actual.amount ?? 0;
    if (actual.reason === "unknown_speed") sample.unknown_mode_events++;
  }
  const checks = {
    source_prefix_unchanged: createHash("sha256").update(prefix).digest("hex") === frozen.source_prefix_sha256,
    original_16_events_preserved: sample.events === 16,
    original_token_total_preserved: sample.total_tokens === 1299940,
    standard_reference_matches: Math.abs(sample.standard_api_usd - 2.951312) < 1e-10,
    unknown_first_mode_preserved: sample.unknown_mode_events === 7,
    confirmed_mode_subtotal_matches: Math.abs(sample.actual_known_api_usd - 1.902306) < 1e-10,
  };
  const live = { events: 0, input: 0, cache_read: 0, cache_write: 0, output: 0,
    standard_api_usd: 0, known_mode_api_usd: 0, unpriced_mode_events: 0, through: "" };
  for (const e of sqlite.query("SELECT * FROM events WHERE path LIKE ? ORDER BY ts").iterate("%01a09983-6ea6-7640-b35b-207aff90a614.jsonl") as Iterable<CodexAccountingEvent>) {
    live.events++; live.input += e.in_tok; live.cache_read += e.cached_in; live.cache_write += e.cache_write; live.output += e.out_tok;
    live.standard_api_usd += priceCodexEvent(pricing, { ...e, speed: "standard" }, "api_equivalent_usd").amount ?? 0;
    const actual = priceCodexEvent(pricing, e, "api_equivalent_usd");
    if (actual.amount === null) live.unpriced_mode_events++;
    else live.known_mode_api_usd += actual.amount;
    live.through = e.ts;
  }
  const report = {
    captured_at: new Date().toISOString(), database: dbPath, rate_card: cardPath,
    rate_card_sha256: createHash("sha256").update(bytes).digest("hex"),
    scope: "Raw indexed events; totals may contain source replicas. API reference is not an invoice or subscription capacity.",
    codex: totals, codex_quality: sqlite.query("SELECT usage_status,cache_write_status,count(*) AS events FROM events GROUP BY usage_status,cache_write_status").all(),
    codex_observation_sources: sqlite.query("SELECT usage_source,count(*) AS events FROM events GROUP BY usage_source").all(),
    raw_standard_api_reference: reference,
    claude: sqlite.query("SELECT count(*) AS events,sum(in_uncached) AS input,sum(in_cache_read) AS cache_read,sum(in_cache_write) AS cache_write,sum(cache_write_5m) AS write_5m,sum(cache_write_1h) AS write_1h,sum(out_total) AS output FROM claude_events").get(),
    claude_cache_conflicts: sqlite.query("SELECT ts,model,in_cache_write,cache_write_5m,cache_write_1h FROM claude_events WHERE in_cache_write<>cache_write_5m+cache_write_1h").all(),
    claude_without_subscription: sqlite.query("SELECT count(*) AS events FROM claude_events WHERE subscription_id IS NULL OR subscription_id=''").get(),
    frozen_conversation: sample, live_conversation_at_import: live, checks,
    subscription_projection: [...subscriptionDailyUsage({ sqlite, rateCards: card })].map(([id, days]) => ({ id,
      ...days.reduce((sum, d) => ({ calls: sum.calls + d.calls, tokens: sum.tokens + d.tokens, priced_usd: sum.priced_usd + d.usd,
        unpriced_calls: sum.unpriced_calls + d.unpriced_calls, unpriced_tokens: sum.unpriced_tokens + d.unpriced_tokens }),
      { calls: 0, tokens: 0, priced_usd: 0, unpriced_calls: 0, unpriced_tokens: 0 }),
    })),
    revisions: sqlite.query("SELECT * FROM sync_revisions").all(), ledgers: sqlite.query("SELECT * FROM usage_ledger_state").all(),
    last_sync: sqlite.query("SELECT status,mode,scope,started_at,finished_at,error FROM sync_runs ORDER BY started_at DESC LIMIT 1").get(),
  };
  if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ...sample, checks, totals, quality: report.codex_quality, last_sync: report.last_sync }, null, 2));
  if (Object.values(checks).some(v => !v)) process.exitCode = 1;
} finally { sqlite.close(); }
