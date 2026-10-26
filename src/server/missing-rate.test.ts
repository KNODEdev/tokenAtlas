import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { readMissingRates } from "./missing-rates";
import { isKnownUnpriced, isMarkedFree, type RateCard } from "./pricing";
import { rateCardsFileReader } from "./rate-cards-file";
import { unpricedModels, type WindowModelTraffic } from "./window-usage";

const card = { version: 1, currency: "USD", unit: "1M", vendors: {
  openai: { models: {
    "gpt-5-codex": { in_uncached: null, in_cache_read: null, in_cache_write: null, out_total: null, confidence: "UNKNOWN" },
    "gpt-5.5": { in_uncached: 1.25, in_cache_read: 0.125, out_total: 10, confidence: "official" },
    "gpt-old": { in_uncached: null, out_total: null, confidence: "official" },
  } },
  anthropic: { models: { "claude-unknown": { in_uncached: null, confidence: "unknown" } } },
} } as unknown as RateCard;

test("only rate-card entries declared UNKNOWN without rates, and the Codex internal review, are known-unpriced", () => {
  expect(isKnownUnpriced(card, "openai", "gpt-5-codex")).toBe(true);
  expect(isKnownUnpriced(card, "codex", "codex-auto-review")).toBe(true);
  expect(isKnownUnpriced(card, "anthropic", "claude-unknown")).toBe(true);
  // A model the card does not name, a priced one and an entry with empty rates but another confidence are not.
  expect(isKnownUnpriced(card, "openai", "gpt-new-sol")).toBe(false);
  expect(isKnownUnpriced(card, "openai", "gpt-5.5")).toBe(false);
  expect(isKnownUnpriced(card, "openai", "gpt-old")).toBe(false);
  expect(isKnownUnpriced(card, "google", "gemini-x")).toBe(false);
  expect(isMarkedFree(card, "opencode", "x-preview-f-free")).toBe(true);
  expect(isMarkedFree(card, "openrouter", "vendor/model:free")).toBe(true);
  expect(isMarkedFree(card, "openrouter", "stealth/ox-alpha")).toBe(false);
  expect(isMarkedFree(card, "openai", "gpt-5.5")).toBe(false);
});

test("a window's unpriced tokens per model come from its counted traffic only", () => {
  const row = (model: string | null, excluded: WindowModelTraffic["excluded"], unpriced: number): WindowModelTraffic => ({
    model, excluded, calls: 1, input: 0, cached: 0, cache_write: 0, output: 0, reasoning: 0, api_standard: 0, unpriced_tokens: unpriced });
  expect(unpricedModels([row("gpt-new-sol", null, 50), row("gpt-5.5", null, 0), row("gpt-new-sol", "funding" as WindowModelTraffic["excluded"], 99),
    row("codex-auto-review", null, 80), row(null, null, 1)]))
    .toEqual([{ model: "codex-auto-review", tokens: 80 }, { model: "gpt-new-sol", tokens: 50 }, { model: "?", tokens: 1 }]);
  expect(unpricedModels([row("gpt-5.5", null, 0)])).toEqual([]);
});

test("the summary comes from the stored missing_rate valuations, without known-unpriced or unpriceable models", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE codex_price_ledger_dims(id INTEGER PRIMARY KEY, model TEXT);
    CREATE TABLE codex_price_ledger_aggregates(grain TEXT, day TEXT, dim_id INTEGER, api_reason TEXT, copy_state TEXT,
      uncached INTEGER, cached INTEGER, output INTEGER);
    CREATE TABLE usage_ledger_dims(id INTEGER PRIMARY KEY, provider TEXT, vendor TEXT, model TEXT);
    CREATE TABLE usage_ledger_day_reasons(provider TEXT, day TEXT, dim_id INTEGER, variant TEXT, reason TEXT, events INTEGER, tokens INTEGER);
    INSERT INTO codex_price_ledger_dims VALUES (1,'gpt-new-sol'),(2,'codex-auto-review'),(3,'gpt-5.5'),(4,'?');
    INSERT INTO codex_price_ledger_aggregates VALUES
      ('day','2026-10-01',1,'missing_rate','canonical',100,1000,10), ('day','2026-10-02',1,'missing_rate','canonical',1,2,3),
      ('day','2026-10-02',1,'missing_rate','duplicate',500,500,500), ('hour','2026-10-02',1,'missing_rate','canonical',9,9,9),
      ('day','2026-10-01',2,'missing_rate','canonical',50,50,50), ('day','2026-10-01',3,'','canonical',70,70,70),
      ('day','2026-10-01',4,'missing_rate','canonical',5,5,5);
    INSERT INTO usage_ledger_dims VALUES (10,'claude',NULL,'claude-new'),(11,'claude',NULL,'claude-opus-5-5'),(12,'glm','openrouter','stealth/x'),
      (13,'gemini',NULL,'claude-opus-4-6-thinking'),(14,'grok',NULL,'grok-new'),(15,'glm','opencode','x-preview-f-free'),
      (16,'glm','openrouter','vendor/model:free');
    INSERT INTO usage_ledger_day_reasons VALUES
      ('claude','2026-10-01',10,'api_standard','missing_rate',3,40), ('claude','2026-10-01',10,'api_actual','missing_rate',2,30),
      ('claude','2026-10-01',11,'api_actual','unknown_mode',9,900), ('glm','2026-10-01',12,'api_global','missing_rate',4,80),
      ('gemini','2026-10-01',13,'api_actual','missing_rate',1,7),
      -- Grok's amounts are xAI's own money; free-marked models cost nothing.
      ('grok','2026-10-01',14,'api_standard','missing_rate',5,500), ('glm','2026-10-01',15,'api_global','missing_rate',6,600),
      ('glm','2026-10-01',16,'api_global','missing_rate',6,600);`);
  const withCodexReview = { ...card, vendors: { ...card.vendors, google: { models: {} } } } as unknown as RateCard;
  expect(readMissingRates(db, withCodexReview)).toEqual({ tokens: 1116 + 40 + 7, models: [
    { model: "gpt-new-sol", observed_provider: "openai", rate_vendor: "openai", tokens: 1116, first_day: "2026-10-01" },
    { model: "claude-new", observed_provider: "anthropic", rate_vendor: "anthropic", tokens: 40, first_day: "2026-10-01" },
    { model: "claude-opus-4-6-thinking", observed_provider: "google", rate_vendor: "google", tokens: 7, first_day: "2026-10-01" },
  ], unpriceable: [{ model: "stealth/x", observed_provider: "openrouter", rate_vendor: null, tokens: 80, first_day: "2026-10-01" }] });
  // The same card marking a model free leaves it out too.
  const free = { ...withCodexReview, vendors: { ...withCodexReview.vendors, anthropic: { models: { "claude-new": { in_uncached: null, free: true } } } } } as unknown as RateCard;
  expect(readMissingRates(db, free).models.map(row => row.model)).toEqual(["gpt-new-sol", "claude-opus-4-6-thinking"]);
  // A corrected valuation leaves the missing-rate set immediately, including its earliest day.
  const beforeRead = (db.query("SELECT total_changes() n").get() as { n: number }).n;
  expect(readMissingRates(db, withCodexReview).models[0]?.tokens).toBe(1116);
  expect((db.query("SELECT total_changes() n").get() as { n: number }).n).toBe(beforeRead);
  db.exec("UPDATE codex_price_ledger_aggregates SET api_reason='' WHERE dim_id=1 AND day='2026-10-01'");
  expect(readMissingRates(db, withCodexReview).models.find(row => row.model === "gpt-new-sol"))
    .toEqual({ model: "gpt-new-sol", observed_provider: "openai", rate_vendor: "openai", tokens: 6, first_day: "2026-10-02" });
  db.exec("DELETE FROM codex_price_ledger_aggregates WHERE dim_id=1 AND copy_state='canonical'");
  expect(readMissingRates(db, withCodexReview).models.some(row => row.model === "gpt-new-sol")).toBe(false);
  db.close();
  // A database before the ledgers exist has nothing to report.
  expect(readMissingRates(new Database(":memory:"), card)).toEqual({ tokens: 0, models: [] });
});

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

test("the rate card file is read again only after it changes, and a half-written file fails until it parses", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rate-cards-")); temporary.push(dir);
  const file = path.join(dir, "rate-cards.json");
  fs.writeFileSync(file, JSON.stringify({ vendors: { openai: { models: {} } } }));
  const read = rateCardsFileReader(() => file);
  const first = read();
  expect(first.changed).toBe(false);
  expect(read().rates).toBe(first.rates);
  expect(read().changed).toBe(false);
  fs.writeFileSync(file, JSON.stringify({ vendors: { openai: { models: { "gpt-new-sol": { in_uncached: 2 } } } } }));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
  const edited = read();
  expect(edited.changed).toBe(true);
  expect(edited.rates?.vendors.openai?.models?.["gpt-new-sol"]?.in_uncached).toBe(2);
  fs.writeFileSync(file, "{\"vendors\": {\"openai\"");
  fs.utimesSync(file, new Date(), new Date(Date.now() + 10_000));
  // The worker reports a turn error and the API keeps its loaded card; the next call reads the file again.
  expect(() => read()).toThrow();
  expect(() => read()).toThrow();
  fs.writeFileSync(file, JSON.stringify({ vendors: { openai: { models: { "gpt-new-sol": { in_uncached: 3 } } } } }));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 15_000));
  const repaired = read();
  expect(repaired.changed).toBe(true);
  expect(repaired.rates?.vendors.openai?.models?.["gpt-new-sol"]?.in_uncached).toBe(3);
});
