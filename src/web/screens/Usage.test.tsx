import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { UsageReport } from "./Usage";
import type { GlobalUsageResponse, GlobalUsageRow } from "../../shared/global-usage";
import type { ClaudeAccountSplitsResponse } from "../../shared/claude-code-capacity";
import { installTestDom, invoke, findByText, type TestNode } from "../lib/test-dom-harness";
import { getLocale, setLanguage, type Language } from "../lib/i18n";

const row: GlobalUsageRow = { day: "2026-09-08", provider: "anthropic", source: "claude", account: "old", model: "model-a",
  calls: 1, tokens: 100, input: 50, cache_read: 20, cache_write: 10, output: 20,
  api_usd: { subtotal: 2, priced_calls: 1, unpriced_calls: 0 }, credits: { subtotal: 0, priced_calls: 0, unpriced_calls: 1 }, credit_unit: null };
const data: GlobalUsageResponse = { since: "2026-09-08", until: "2026-09-09", timezone: "UTC", rows: [row, { ...row, day: "2026-09-09", model: "model-b", tokens: 200 }],
  sources: [{ id: "claude", available: true, events: 2 }], excluded_duplicates: 0, conflicting_events: 0, approximate_time_events: 0, actual_cost_available: false };
const review: GlobalUsageRow = { ...row, provider: "openai", source: "codex", model: "codex-auto-review", calls: 4, tokens: 200,
  internal_tokens: 200, api_usd: { subtotal: 0, priced_calls: 0, unpriced_calls: 4 } };
let root: Root | null = null;
let restore = () => {};
let previousLanguage: Language = "en";
beforeEach(() => {
  previousLanguage = getLocale() === "pl-PL" ? "pl" : "en";
  setLanguage("en");
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; restore(); setLanguage(previousLanguage); });
function nodes(node: TestNode): TestNode[] { return [node, ...node.children.flatMap(nodes)]; }
async function mount(report = data, claudeSplits: ClaudeAccountSplitsResponse | null = null) {
  const dom = installTestDom(); restore = dom.restore; setLanguage("en");
  globalThis.requestAnimationFrame = callback => Number(setTimeout(() => callback(0), 0));
  globalThis.cancelAnimationFrame = id => clearTimeout(id);
  root = createRoot(dom.host as unknown as HTMLElement);
  await act(async () => root!.render(<UsageReport data={report} claudeSplits={claudeSplits} />));
  return dom.host;
}
const bar = (host: TestNode, day: string) => nodes(host).find(node => node.getAttribute("role") === "button" && node.getAttribute("aria-label")?.startsWith(`${day} UTC`))!;
const button = (host: TestNode, text: string) => nodes(host).find(node => node.tagName === "BUTTON" && node.textContent === text)!;
const table = (host: TestNode) => nodes(host).find(node => node.tagName === "TABLE")!;

test("four measures, internal review only as captions, and the table's token column uses the chart's measure", async () => {
  const host = await mount({ ...data, rows: [row, review] });
  const measures = nodes(host).filter(node => node.tagName === "BUTTON" && node.className !== "data-table-sort-button" && ["Tokens", "API-eq $", "Calls", "Credits"].includes(node.textContent));
  expect(measures).toHaveLength(4);
  expect(host.textContent).not.toContain("Actual charges");
  expect(host.textContent).not.toContain("Internal review tokens");
  expect(host.textContent).toContain("+ 200 Codex internal review · unpriced");
  expect(host.textContent).toContain("+ 4 internal review calls");
  expect(bar(host, "2026-09-08").getAttribute("aria-label")).toContain("UTC · 100");
  // The review row is neither a provider row nor part of the token column.
  expect(table(host).textContent).not.toContain("OpenAI");
  await invoke(button(host, "▸ Anthropic"), "onClick");
  expect(table(host).textContent).not.toContain("Codex internal review");
  const tokenCells = nodes(table(host)).filter(node => node.tagName === "TD" && node.getAttribute("title")?.startsWith("fresh input"));
  expect(tokenCells.map(cell => cell.textContent)).toEqual(["100", "100"]);
});

test("tiles show token composition, pricing coverage and calls by provider", async () => {
  const unpriced: GlobalUsageRow = { ...row, provider: "openai", source: "codex", model: "gpt-x", calls: 3, tokens: 300, input: 100, cache_read: 200, cache_write: 0, output: 0,
    api_usd: { subtotal: 0, priced_calls: 0, unpriced_calls: 3 } };
  const host = await mount({ ...data, rows: [row, unpriced] });
  expect(host.textContent).toContain("API-eq · known part");
  expect(host.textContent).toContain("≥ $2.00");
  expect(host.textContent).toContain("75% of calls have no price — not counted as 0 · most: gpt-x 3");
  expect(host.textContent).toContain("OpenAI 75.0% · Anthropic 25.0%");
  expect(host.textContent).toContain("cache read 55.0% · fresh input 37.5% · output 5.0% · cache write 2.5%");
});

test("bar selection scopes table rows and provider expansion exposes only the selected day's models", async () => {
  const host = await mount();
  await invoke(bar(host, "2026-09-08"), "onClick");
  expect(host.textContent).toContain("Providers and models · 2026-09-08");
  await invoke(button(host, "▸ Anthropic"), "onClick");
  expect(table(host).textContent).toContain("model-a");
  expect(table(host).textContent).not.toContain("model-b");
  await invoke(findByText(host, "BUTTON", "Whole period")!, "onClick");
  expect(table(host).textContent).toContain("model-b");
});

test("unsupported credit valuation stays unavailable in the chart and table averages/shares", async () => {
  const host = await mount();
  await invoke(button(host, "Credits"), "onClick");
  expect(bar(host, "2026-09-08").getAttribute("aria-label")).toContain("Valuation unavailable");
  const cells = nodes(nodes(host).find(node => node.tagName === "TBODY")!).filter(node => node.tagName === "TD");
  expect(cells[1]!.textContent).toBe("—");
  expect(cells.at(-1)!.textContent).toBe("—");
});

test("token type columns open on demand and models beyond the first five are summarised", async () => {
  const rows = ["m1", "m2", "m3", "m4", "m5", "m6", "m7"].map((model, index) => ({ ...row, model, tokens: 100 * (7 - index) }));
  const host = await mount({ ...data, rows });
  expect(table(host).textContent).not.toContain("cache write");
  await invoke(button(host, "+ token type columns"), "onClick");
  expect(table(host).textContent).toContain("cache write");
  await invoke(button(host, "▸ Anthropic"), "onClick");
  expect(table(host).textContent).toContain("+ 2 others (m6, m7) · 300");
});

test("the model breakdown keeps the top six models and one series for the rest", async () => {
  const rows = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"].map((model, index) => ({ ...row, model, tokens: 100 * (8 - index) }));
  const host = await mount({ ...data, rows });
  await invoke(button(host, "Models (top 6)"), "onClick");
  const legend = nodes(host).find(node => node.className.includes("usage-legend"))!;
  expect(legend.children).toHaveLength(7);
  expect(legend.textContent).toContain("Other models 8.3%");
  expect(legend.textContent).not.toContain("m7");
});

test("deselecting all providers gives an empty result, choosing all restores it", async () => {
  const host = await mount();
  const providerFilter = nodes(host).find(node => node.tagName === "DETAILS")!;
  await invoke(findByText(providerFilter, "BUTTON", "None")!, "onClick");
  expect(host.textContent).toContain("No indexed events match these filters.");
  await invoke(findByText(providerFilter, "BUTTON", "All")!, "onClick");
  expect(host.textContent).not.toContain("No indexed events match these filters.");
});

test("the Claude whole-account estimate folds one row per week and follows the provider filter", async () => {
  const split = (percent: number, usd: number) => ({ as_of: null, share_percent: percent, account_api_usd: usd * 100 / percent, account_tokens: 1000 * 100 / percent, rows: [
    { key: "claude_code", percent, display_name: "Claude Code", measured: true, api_usd: usd, tokens: 1000 },
    { key: "outside_code_unsplit", percent: 100 - percent, display_name: null, measured: false, api_usd: usd * (100 - percent) / percent, tokens: 1000 * (100 - percent) / percent },
  ] });
  const splits: ClaudeAccountSplitsResponse = { since: data.since, until: data.until, pending: false, windows: [
    { account: "old", window_started_at: "2026-09-13T10:00:00Z", reset_at: "2026-09-20T10:00:00Z", split: split(50, 100) },
  ] };
  const host = await mount(data, splits);
  const fold = nodes(host).find(node => node.tagName === "DETAILS" && node.textContent.startsWith("Claude — whole account"))!;
  expect(fold.textContent).toContain("1 week from 09/13 · Claude Code 50% of the account · whole account ≈ $200.00");
  expect(fold.textContent).toContain("50% · $100.00 · 1k");
  expect(fold.textContent).toContain("50% · ≈ $100.00 · ≈ 1k (no split)");
  const providerFilter = nodes(host).find(node => node.tagName === "DETAILS")!;
  await invoke(findByText(providerFilter, "BUTTON", "None")!, "onClick");
  expect(host.textContent).not.toContain("Claude — whole account");
});
