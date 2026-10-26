import { test, expect, spyOn } from "bun:test";
import type { CodexComparisonWindow } from "../../shared/codex-accounting";
import { emptyWindowUsage } from "../../server/subscription-window-comparison";
import { emptyWindowEvidence } from "../../server/subscription-evidence";
import { api } from "./api";
import { readGlobalCapacity } from "./global-capacity";
function sample(account: string, day: number, minutes: number): CodexComparisonWindow {
  const date = "2026-09-" + String(day).padStart(2, "0");
  return { id: `${account}:${date}:${minutes}`, account, plan: "pro", window_minutes: minutes,
    start: date + "T00:00:00Z", end: date + "T04:00:00Z", reset: date + "T05:00:00Z",
    start_percent: 10, end_percent: 60, observed_pp: 50, probes: 20, max_gap_hours: 0.25,
    usage: { ...emptyWindowUsage(), events: 20, tokens: 500_000, input: 400_000, cached: 300_000, output: 100_000, priced_tokens: 500_000, api_standard: 500, credits_low: 1000, credits_high: 1000 },
    sources: [], models: [], plan_detail: { status: "resolved", label: "Pro", multiplier: 20 }, evidence: emptyWindowEvidence(),
    promotion: { status: "configured", factor: 1, regime_ids: [], notes: [], sources: [] } };
}
const account = (id: string, provider: string) => ({ id, label: id, active: true, provider });

test("every account's cycles come from one read of the stored cycles, kept per account and counter", async () => {
  const session = JSON.stringify(["session", "", 300]), other = JSON.stringify(["session", "opus", 300]);
  const read = spyOn(api, "capacityCycles").mockImplementation(async options => ({ ...options, accounts: [
    { account: "a", provider: "codex", counter: "five_hour", counter_label: "5h", windows: [sample("a", 1, 300), sample("b", 1, 300), sample("a", 2, 10080)] },
    { account: "c", provider: "claude", counter: session, counter_label: "session", windows: [sample("c", 3, 300)] },
    { account: "c", provider: "claude", counter: other, counter_label: "opus", windows: [], preparing: true },
  ] }));
  try {
    const results = await readGlobalCapacity([account("A", "codex"), account("c", "claude"), account("d", "gemini"), account("x::business", "codex")],
      { since: "2026-09-01", until: "2026-09-12" }, 300);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[0]).toEqual({ since: "2026-09-01", until: "2026-09-12", window_minutes: 300 });
    // Only the account's own windows of the asked length; ids match case-insensitively.
    expect(results.get("A")?.map(result => result.windows.map(window => window.id))).toEqual([["a:2026-09-01:300"]]);
    expect(results.get("c")?.map(result => [result.counter, result.windows.length, result.preparing ?? false])).toEqual([[session, 1, false], [other, 0, true]]);
    // An account the server does not answer, and a business account, have no cycles to compare.
    expect(results.get("d")).toEqual([{ account: account("d", "gemini"), counter: "", counterLabel: "", windows: [], unavailable: true }]);
    expect(results.get("x::business")?.[0]?.unavailable).toBe(true);
  } finally { read.mockRestore(); }
});

test("a failed read is reported to the caller", async () => {
  const read = spyOn(api, "capacityCycles").mockRejectedValue(new Error("Read failed"));
  try {
    await expect(readGlobalCapacity([account("a", "codex")], { since: "2026-09-01", until: "2026-09-12" }, 10080)).rejects.toThrow("Read failed");
  } finally { read.mockRestore(); }
});
