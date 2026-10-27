import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SubscriptionSplitTable } from "./SubscriptionSplitTable";
import type { SplitLine } from "./subscriptions";
import { planPeriodsTooltip } from "./subscriptions";
import type { SubscriptionSpend } from "../../lib/api";
import { billingUnavailable } from "../../lib/plan-cost-status";
import { setLanguage } from "../../lib/i18n";
import type { BillingUnavailableReason } from "../../../shared/plan-price-coverage";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { installTestDom, invoke, type TestNode } from "../../lib/test-dom-harness";

const line: SplitLine = { subId: "account", plan: "Pro · ×20", planHistory: null, tokens: 10, color: "var(--codex)",
  billedUsd: null, billingUnavailableReasons: ["plan_history_gap"], costAtFullUseUsd: null, apiUsd: 5,
  equivalents: { full_5h_sessions: { value: null, absent: "no_capacity" }, weekly_cycles: { value: null, absent: "no_capacity" },
    monthly_subscriptions: { value: null, absent: "no_capacity" } },
  provenance: { capacity: "none", price: "none", cadence: "none", calibration_covers_period: false, coverage: "none", measured_share: 0 } };

test("an unknown calendar allocation shows its backend cause rather than claiming the global price is absent", () => {
  setLanguage("en");
  const html = renderToStaticMarkup(<SubscriptionSplitTable lines={[line, { ...line, subId: "priced", billedUsd: 10 }]} />);
  expect(html).toContain("plan history gap");
  expect(html).toContain("Global catalog price".toLowerCase());
  expect(html).not.toContain("no plan price");
  expect(html).toContain("≥ $10");
});

test("FX, missing price and incomplete usage retain distinct shared reasons in both languages", () => {
  for (const language of ["en", "pl"] as const) {
    setLanguage(language);
    const reasons: BillingUnavailableReason[] = ["fx_rate_pending", "plan_price_missing", "usage_incomplete"];
    const labels = reasons.map(reason => billingUnavailable([reason]).label);
    expect(new Set(labels).size).toBe(3);
    expect(billingUnavailable().label).not.toBe(language === "en" ? "no plan price" : "brak ceny planu");
  }
  setLanguage("en");
});

const historyLine: SplitLine = { ...line, subId: "hello", plan: "Plus · ×1 → Free", vendor: "codex",
  billedUsd: 12.31, billedComplete: true, planPeriods: [
    { from_ts: "2026-09-01T00:00:00Z", until_ts: "2026-10-13T09:17:59Z", plan: "plus", subscription_cost_usd: 30,
      tokens: 80, calls: 2, api_usd: 4, share: 0.4, billed_usd: 12.31, billing_unavailable_reasons: [] },
    { from_ts: "2026-10-13T09:17:59Z", until_ts: "2026-10-20T00:00:00Z", plan: "free", subscription_cost_usd: 0,
      tokens: 20, calls: 1, api_usd: 1, share: 0.2, billed_usd: 0, billing_unavailable_reasons: [] },
  ] };

test("a historical total is labelled as history instead of the final Free plan", () => {
  setLanguage("en");
  const html = renderToStaticMarkup(<SubscriptionSplitTable lines={[historyLine]} nameOf={() => "hello@example.test"} />);
  expect(html).toContain("plan history");
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain(">Free<");
  expect(html).toContain("$12.31");
});

function nodes(node: TestNode): TestNode[] { return [node, ...node.children.flatMap(nodes)]; }
test("expanding shows the newest Free period above older Plus; totals are not counted twice and more columns preserve expansion", async () => {
  setLanguage("en");
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  try {
    await act(async () => root.render(<SubscriptionSplitTable lines={[historyLine]} />));
    const toggle = nodes(dom.host).find(node => node.tagName === "BUTTON" && node.getAttribute("aria-label")?.startsWith("Expand plan history"))!;
    expect(nodes(dom.host).filter(node => node.tagName === "TR").length).toBe(3);
    await invoke(toggle, "onClick");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const rows = nodes(dom.host).filter(node => node.tagName === "TR");
    expect(rows.length).toBe(5);
    expect(rows[2]!.textContent).toContain("Free");
    expect(rows[2]!.textContent).toContain("$0.00");
    expect(rows[3]!.textContent).toContain("Plus");
    expect(rows[4]!.textContent).toContain("$12.31");
    await act(async () => root.render(<SubscriptionSplitTable lines={[historyLine]} moreColumns />));
    expect(nodes(dom.host).filter(node => node.tagName === "TR").length).toBe(5);
    await invoke(toggle, "onClick");
    expect(nodes(dom.host).filter(node => node.tagName === "TR").length).toBe(3);
  } finally { await act(async () => root.unmount()); dom.restore(); }
});

test("account rows follow latest activity, even when an older account cost more", () => {
  setLanguage("en");
  const html = renderToStaticMarkup(<SubscriptionSplitTable lines={[
    { ...line, subId: "old-account", billedUsd: 200, lastActivityDay: "2026-09-01" },
    { ...line, subId: "new-account", billedUsd: 1, lastActivityDay: "2026-10-26" },
  ]} />);
  expect(html.indexOf("new-account")).toBeLessThan(html.indexOf("old-account"));
});

test("partial dated costs mark both the account and total as lower bounds", () => {
  setLanguage("en");
  const html = renderToStaticMarkup(<SubscriptionSplitTable lines={[{ ...historyLine, billedComplete: false }]} />);
  expect(html.split("≥ $12.31").length - 1).toBe(2);
});

test("an unknown allocation is described by its cause instead of a misleading zero", () => {
  setLanguage("en");
  const html = renderToStaticMarkup(<SubscriptionSplitTable lines={[{ ...line, billedUsd: 0, billedComplete: false }]} />);
  expect(html).toContain("plan history gap");
  expect(html).not.toContain("≥ $0");
});

test("tooltip history puts later intraday plan changes first even when day labels match", () => {
  setLanguage("en");
  const spend: SubscriptionSpend = { id: "acct", vendor: "claude", plan: "pro → max-20x", usd_per_month: null,
    usd_per_month_declared: null, api_usd: 0, attributed_usd: 0, first_day: "2026-10-01", last_day: "2026-10-01",
    days: 1, paid_usd: 150, basis: "rate-card", plan_periods: [
      { plan: "pro", usd_per_month: 100, from: "2026-10-01", until: "2026-10-01", days: 0.5, usd: 50, source: "declared" },
      { plan: "max-20x", usd_per_month: 200, from: "2026-10-01", until: "2026-10-01", days: 0.5, usd: 100, source: "declared" },
    ] };
  const hint = planPeriodsTooltip(spend)!;
  expect(hint.indexOf("$200")).toBeLessThan(hint.indexOf("$100"));
});
