import { expect, spyOn, test } from "bun:test";
import type { AmountCoverage, CodexAccountingReport } from "../../shared/codex-accounting";
import { api, type ApiAccount } from "./api";
import { aggregateModelReports, modelReportAccounts, readAllModelReports } from "./all-model-reports";

const scope = { account: "all", since: "2026-10-01", until: "2026-10-28" };
export function modelReport(provider: string, account: string, tokens: number, api: number, missing = false): CodexAccountingReport {
  const base = aggregateModelReports([], { ...scope, account });
  const amount: AmountCoverage = { value: missing ? null : api, status: missing ? "unpriced" : "complete", priced_subtotal: api,
    priced_events: missing ? 0 : 1, unpriced_events: missing ? 1 : 0, priced_tokens: missing ? 0 : tokens, unpriced_tokens: missing ? tokens : 0, reasons: {} };
  const normalization = { ...base.normalization, standard_api_usd: amount };
  return { ...base, provider: { ...base.provider!, id: provider }, events: 1, tokens, known_speed_events: 1, known_speed_tokens: tokens,
    amounts: { ...base.amounts, api_equivalent_usd: amount }, normalization, source_home_count: 1,
    breakdown: [{ day: "2026-10-20", model: "gpt-6.1-sol", speed: "standard", account, home: "desktop", events: 1, tokens, amounts: base.amounts, normalization }] };
}

test("All adds prepared model and UTC-day facts without adding separate limit percentages or erasing missing prices", () => {
  const reports = [modelReport("codex", "codex1", 1000, 1.125), modelReport("claude", "claude1", 2000, 0, true)];
  const before = JSON.stringify(reports);
  const all = aggregateModelReports(reports, scope);
  expect(all).toMatchObject({ scope, tokens: 3000, events: 2, windows: null, provider: { id: "all", counter: null, credits: false } });
  expect(all.normalization.standard_api_usd).toMatchObject({ value: null, priced_subtotal: 1.125, status: "partial", unpriced_events: 1 });
  expect(all.traffic_periods).toHaveLength(1);
  expect(all.traffic_periods![0]).toMatchObject({ tokens: 3000, api: 1.125, events: 2, priced_tokens: 1000, start: "2026-10-20T00:00:00.000Z", end: "2026-10-21T00:00:00.000Z" });
  expect(all.breakdown.map(row => row.account)).toEqual(["codex1", "claude1"]);
  expect(all.source_home_count).toBe(2);
  expect(JSON.stringify(reports)).toBe(before);
});

test("All reads each subscription once with its own adapter and retains the date and project scope", async () => {
  const accounts = [{ id: "all", vendor: null, has_events: true }, { id: "codex1", vendor: "openai", has_events: true },
    { id: "claude1", vendor: "anthropic", has_events: true }, { id: "empty", vendor: "codex", has_events: false }] as ApiAccount[];
  expect(modelReportAccounts(accounts)).toHaveLength(2);
  const codex = spyOn(api, "codexAccounting").mockResolvedValue(modelReport("codex", "codex1", 1000, 1));
  const claude = spyOn(api, "subscriptionAccounting").mockResolvedValue(modelReport("claude", "claude1", 2000, 2));
  try {
    const report = await readAllModelReports(accounts, { ...scope, project: "example" });
    expect(report.tokens).toBe(3000);
    expect(codex.mock.calls[0]![0]).toMatchObject({ account: "codex1", since: scope.since, until: scope.until, project: "example" });
    expect(claude.mock.calls[0]![0]).toMatchObject({ provider: "claude", account: "claude1", project: "example" });
    expect(codex).toHaveBeenCalledTimes(1); expect(claude).toHaveBeenCalledTimes(1);
  } finally { codex.mockRestore(); claude.mockRestore(); }
});

test("an unavailable subscription prevents an incomplete All report from appearing complete", async () => {
  const read = spyOn(api, "codexAccounting").mockRejectedValue(new Error("Preparing model facts"));
  try {
    await expect(readAllModelReports([{ id: "codex1", vendor: "codex", has_events: true }] as ApiAccount[], scope)).rejects.toThrow("codex1: Preparing model facts");
  } finally { read.mockRestore(); }
});
