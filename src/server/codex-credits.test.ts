import { expect, test } from "bun:test";
import rateCards from "../../rate-cards.json";
import { fixture, capture, SOURCE_A } from "../../scripts/benchmark-cycle-breakdown";
import { declareCodexEraPeriods } from "./codex-periods.fixture";
import { prepareProbeReaderFixture } from "./probe-reader.fixture";
import { calculateCodexUsd, codexCreditEquivalent, getCodexRate, type RateCard } from "./pricing";
import { prepareCodexLedgerFixture } from "./codex-ledger.fixture";

test("Astra API and credit references count fresh input, cache and output separately", () => {
  const card = rateCards as RateCard;
  expect(calculateCodexUsd(getCodexRate(card, "gpt-6-astra"), 1e6, 5e5, 0, 1e6)).toBe(55.5);
  expect(codexCreditEquivalent(card, "gpt-6-astra", 1e6, 5e5, 1e6)).toBe(1387.5);
  const discounted = structuredClone(card);
  discounted.vendors.openai!.models!["gpt-6-astra"]!.out_total = 20;
  expect(codexCreditEquivalent(discounted, "gpt-6-astra", 1e6, 5e5, 1e6)).toBe(1387.5);
});

test("unknown or unsupported credit inputs remain unavailable", () => {
  for (const args of [["missing", 1, 0, 1, 0], ["gpt-6-astra", 1, 2, 1, 0], ["gpt-6-astra", 1, 0, 1, 1], ["gpt-6-astra", -1, 0, 1, 0]] as const) {
    expect(codexCreditEquivalent(rateCards as RateCard, args[0], args[1], args[2], args[3], args[4])).toBeNull();
  }
});

test("cycle credit equivalent is owned, bounded, counted once and explicit about missing models", async () => {
  const ctx = fixture();
  try {
    // Explicit synthetic dates and flat rates isolate ownership and token-bucket accounting.
    ctx.rateCards = { ...rateCards, codex_accounting: {version:1,rules:rateCards.codex_accounting.rules
      .filter(rule=>rule.model==="gpt-6-astra" && rule.valid_from==="2026-09-08")
      .map(rule=>({...rule,valid_from:"2000-01-01",long_context:undefined,confidence:"user",sources:["https://example.test/synthetic-price"]}))} } as RateCard;
    ctx.sqlite.exec("DELETE FROM events");
    const put = ctx.sqlite.query("INSERT INTO events(home,path,ts,model,project_id,in_tok,cached_in,cache_write,out_tok) VALUES ('A', ?, ?, ?, NULL, 1000000, 500000, 0, 1000000)");
    put.run("p", "2026-04-01T12:30:00.000Z", "gpt-6-astra");
    // Owned by nobody: an instant in a gap between the account's periods.
    put.run("unowned", "2026-04-01T12:31:30.000Z", "gpt-6-astra");
    declareCodexEraPeriods(ctx.sqlite, [{ ...SOURCE_A, until: "2026-04-01T12:31:00.000Z" }, { ...SOURCE_A, from: "2026-04-01T12:32:00.000Z" }], { replace: true });
    prepareProbeReaderFixture(ctx.sqlite, [SOURCE_A]);
    put.run("p", "1999-01-01T00:00:00.000Z", "gpt-6-astra");
    prepareCodexLedgerFixture(ctx.sqlite,ctx.rateCards,new Map([["a","a"]]),[SOURCE_A]);
    const priced = (await capture(ctx)).body;
    expect(priced.totals.calls).toBe(1);
    expect(priced.totals.usd).toBe(55.5);
    expect(priced.credit_equivalent.value).toBe(1387.5);
    expect(priced.credit_equivalent.basis).toBe("dated-standard-reference");
    put.run("p", "2026-04-01T12:30:00.000Z", "unpublished-model");
    prepareProbeReaderFixture(ctx.sqlite, [SOURCE_A]);
    prepareCodexLedgerFixture(ctx.sqlite,ctx.rateCards,new Map([["a","a"]]),[SOURCE_A]);
    const partial = (await capture(ctx)).body;
    expect(partial.credit_equivalent.value).toBeNull();
    expect(partial.credit_equivalent.priced_credits).toBe(1387.5);
    expect(partial.credit_equivalent.unpriced_calls).toBe(1);
    expect(partial.unpriced.tokens).toBeGreaterThan(0);
  } finally { ctx.sqlite.close(); }
});
