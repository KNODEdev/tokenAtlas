import { describe, expect, test } from "bun:test";
import { codexCreditExtra, codexProbeAdapter } from "../providers/adapters/codex";
import { creditPoolFlows, creditPoolReadings, creditPoolsInRange, creditPoolsOfRange, decodeCreditPools, statesCreditPools } from "./credit-pools";

// Shapes as the live probes stored them on 2026-10-08/09.
const claudeExtra = (used: number, extra: Record<string, unknown> = {}) => ({
  severity: "normal", is_active: true,
  "claude.raw.five_hour.utilization": 12,
  "claude.raw.iguana_necktie.limit_dollars": 250,
  "claude.raw.iguana_necktie.used_dollars": used,
  "claude.raw.iguana_necktie.remaining_dollars": 250 - used,
  "claude.raw.iguana_necktie.resets_at": "2026-11-05T07:59:00+00:00",
  "claude.raw.iguana_necktie.utilization": used / 2.5,
  "claude.raw.extra_usage.is_enabled": false,
  "claude.raw.spend.used.amount_minor": 0,
  "claude.raw.spend.used.currency": "USD",
  "claude.raw.spend.used.exponent": 2,
  ...extra,
});
const codexRaw = (balance: string, resetIds: string[]) => ({
  rateLimits: { limitId: "codex", planType: "pro", credits: { hasCredits: true, unlimited: false, balance } },
  rateLimitsByLimitId: {
    base_model_inference: { limitId: "base_model_inference", planType: "pro", credits: null },
    codex: { limitId: "codex", planType: "pro", credits: { hasCredits: true, unlimited: false, balance } },
  },
  rateLimitResetCredits: { availableCount: resetIds.length, credits: resetIds.map((id, index) => ({
    id, resetType: "codexRateLimits", status: "available", grantedAt: 1790108620 + index * 600_000,
    expiresAt: 1792700620 + index * 600_000, title: "Full reset", description: "free reset" })) },
});

describe("credit pools", () => {
  test("a Claude grant meter is a USD pool; window meters and disabled extra usage are not", () => {
    const pools = decodeCreditPools("claude", claudeExtra(8.100979));
    expect(pools).toEqual([{ key: "claude:iguana_necktie", kind: "grant", unit: "usd", granted: 250, used: 8.100979,
      remaining: 241.899021, remaining_text: null, unlimited: false, granted_at: null,
      expires_at: "2026-11-05T07:59:00+00:00", items: null }]);
  });

  test("enabled extra usage adds the purchased pool", () => {
    const pools = decodeCreditPools("claude", claudeExtra(0, { "claude.raw.extra_usage.is_enabled": true,
      "claude.raw.spend.used.amount_minor": 1250, "claude.raw.spend.limit.amount_minor": 5000 }));
    expect(pools.find(pool => pool.key === "claude:spend")).toMatchObject({ kind: "purchase", granted: 50, used: 12.5, remaining: 37.5 });
  });

  test("the Codex probe stores the exact balance and the reset list", () => {
    const extra = codexCreditExtra(codexRaw("60749.9557035000", ["r1", "r2", "r3"]) as never);
    expect(extra["codex.credits.balance"]).toBe("60749.9557035000");
    const pools = decodeCreditPools("codex", extra);
    expect(pools.map(pool => [pool.key, pool.remaining, pool.remaining_text])).toEqual([
      ["codex:credits", 60749.9557035, "60749.9557035000"], ["codex:resets", 3, null]]);
    expect(pools[1]!.expires_at).toBe("2026-10-22T20:23:40.000Z");
  });

  test("an account without credits has no balance pool", () => {
    const raw = { rateLimits: { limitId: "codex", credits: { hasCredits: false, unlimited: false, balance: null } } };
    expect(decodeCreditPools("codex", codexCreditExtra(raw as never))).toEqual([]);
  });

  test("only readings that carry pool fields state pools; an empty decode of one is no pools, not unknown", () => {
    expect(statesCreditPools("claude", claudeExtra(0))).toBe(true);
    expect(statesCreditPools("claude", { severity: "normal", "claude.raw.five_hour.utilization": 3 })).toBe(true);
    expect(statesCreditPools("claude", { severity: "normal" })).toBe(false);
    const none = codexCreditExtra({ rateLimits: { limitId: "codex", credits: { hasCredits: false, unlimited: false, balance: null } } } as never);
    expect(statesCreditPools("codex", none)).toBe(true);
    expect(decodeCreditPools("codex", none)).toEqual([]);
    expect(statesCreditPools("codex", { "codex.plan": "pro" })).toBe(false);
    expect(statesCreditPools("gemini", claudeExtra(0))).toBe(false);
  });

  test("flows: spent, received and expired across readings", () => {
    const at = (ts: string, raw: ReturnType<typeof codexRaw>) =>
      ({ ts, pools: decodeCreditPools("codex", codexCreditExtra(raw as never)) });
    const flows = creditPoolFlows([
      at("2026-10-07T08:00:00.000Z", codexRaw("60749.5", ["r1", "r2"])),
      at("2026-10-08T08:00:00.000Z", codexRaw("60000", ["r1", "r2"])),
      // A top-up and one reset used before its expiry.
      at("2026-10-09T08:00:00.000Z", codexRaw("70000", ["r1", "r3"])),
      at("2026-10-10T08:00:00.000Z", codexRaw("69000", ["r1", "r3"])),
    ]);
    expect(flows).toEqual([
      { key: "codex:credits", unit: "credits", since: "2026-10-07T08:00:00.000Z", start_remaining: 60749.5, end_remaining: 69000, spent: 1749.5, added: 10000, expired: 0 },
      { key: "codex:resets", unit: "resets", since: "2026-10-07T08:00:00.000Z", start_remaining: 2, end_remaining: 2, spent: 1, added: 1, expired: 0 },
    ]);
  });

  test("a reset gone after its expiry is lost, not spent", () => {
    const raw = codexRaw("1", ["r1"]);
    const pools = (ts: string, ids: string[]) => ({ ts, pools: decodeCreditPools("codex", codexCreditExtra({ ...raw,
      rateLimitResetCredits: { availableCount: ids.length, credits: raw.rateLimitResetCredits.credits.filter(c => ids.includes(c.id)) } } as never)) });
    expect(creditPoolFlows([pools("2026-10-29T00:00:00.000Z", ["r1"]), pools("2026-11-01T00:00:00.000Z", [])])
      .find(flow => flow.key === "codex:resets")).toMatchObject({ end_remaining: 0, spent: 0, expired: 1 });
    expect(creditPoolFlows([pools("2026-10-20T00:00:00.000Z", ["r1"]), pools("2026-10-20T01:00:00.000Z", [])])
      .find(flow => flow.key === "codex:resets")).toMatchObject({ end_remaining: 0, spent: 1, expired: 0 });
  });

  test("a grant's spend comes from its used amount; readings without pools are skipped", () => {
    const range = creditPoolsOfRange("claude", [
      { ts: "2026-10-02T17:24:29.996Z", extra: JSON.stringify(claudeExtra(0.178234)) },
      { ts: "2026-10-03T00:00:00.000Z", extra: JSON.stringify({ severity: "normal" }) },
      { ts: "2026-10-06T00:21:19.081Z", extra: JSON.stringify(claudeExtra(4.328978)) },
      { ts: "2026-10-07T07:08:49.726Z", extra: JSON.stringify(claudeExtra(8.100979)) },
      { ts: "2026-10-07T08:00:00.000Z", extra: null },
    ]);
    expect(range?.read_at).toBe("2026-10-07T07:08:49.726Z");
    expect(range?.flows[0]!.spent).toBeCloseTo(7.922745, 6);
    expect(range?.flows[0]!.added).toBe(0);
  });

  test("a change across a gap between windows is counted once, in the window of the later reading", () => {
    // The live account: no readings 10-04..10-05, a window reset on 10-04.
    const readings = creditPoolReadings("claude", [
      { ts: "2026-10-02T17:24:29.996Z", extra: JSON.stringify(claudeExtra(0.178234)) },
      { ts: "2026-10-03T22:00:00.000Z", extra: JSON.stringify(claudeExtra(0.178234)) },
      { ts: "2026-10-06T00:21:19.081Z", extra: JSON.stringify(claudeExtra(4.328978)) },
      { ts: "2026-10-07T07:08:49.726Z", extra: JSON.stringify(claudeExtra(8.100979)) },
    ]);
    const earlier = creditPoolsInRange(readings, Date.parse("2026-09-27T00:00:00Z"), Date.parse("2026-10-04T00:00:00Z"));
    const later = creditPoolsInRange(readings, Date.parse("2026-10-04T00:00:00Z"), Date.parse("2026-10-08T00:00:00Z"));
    expect(later!.flows[0]).toMatchObject({ since: "2026-10-03T22:00:00.000Z", start_remaining: 249.821766, end_remaining: 241.899021 });
    expect(earlier!.flows[0]!.spent + later!.flows[0]!.spent).toBeCloseTo(8.100979 - 0.178234, 6);
    expect(creditPoolsInRange(readings, Date.parse("2026-10-04T00:00:00Z"), Date.parse("2026-10-05T00:00:00Z"))).toBeNull();
  });

  test("a balance change is the exact decimal difference", () => {
    const readings = creditPoolReadings("codex", [
      { ts: "2026-10-09T09:00:00.000Z", extra: JSON.stringify(codexCreditExtra(codexRaw("60749.9557035000", []) as never)) },
      { ts: "2026-10-09T09:05:00.000Z", extra: JSON.stringify(codexCreditExtra(codexRaw("60700.5000000000", []) as never)) },
      { ts: "2026-10-09T09:10:00.000Z", extra: JSON.stringify(codexCreditExtra(codexRaw("60700.6", []) as never)) },
    ]);
    const flow = creditPoolFlows(readings).find(item => item.key === "codex:credits")!;
    expect(flow.spent).toBe(49.4557035);
    expect(flow.added).toBe(0.1);
  });

  test("one row per Codex reading carries the credits, with a compact reset list", () => {
    const raw = codexRaw("60749.9557035000", ["r1"]);
    const withWindows = { ...raw,
      rateLimits: { ...raw.rateLimits, primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 1791500000 },
        secondary: { usedPercent: 43, windowDurationMins: 10080, resetsAt: 1791900000 } },
      rateLimitsByLimitId: {
        base_model_inference: { limitId: "base_model_inference", credits: null, primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1791900000 } },
        codex: { ...raw.rateLimitsByLimitId.codex, primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 1791500000 },
          secondary: { usedPercent: 43, windowDurationMins: 10080, resetsAt: 1791900000 } } } };
    const { readings } = codexProbeAdapter.parse(withWindows as never) as { readings: Array<{ group: string; kind: string; extra: Record<string, unknown> | null }> };
    expect(readings).toHaveLength(3);
    const carriers = readings.filter(reading => reading.extra != null);
    expect(carriers.map(reading => [reading.group, reading.kind])).toEqual([["codex", "primary"]]);
    expect(JSON.parse(carriers[0]!.extra!["codex.reset_credits"] as string)).toEqual([
      { id: "r1", granted_at: "2026-09-22T20:23:40.000Z", expires_at: "2026-10-22T20:23:40.000Z" }]);
  });
});
