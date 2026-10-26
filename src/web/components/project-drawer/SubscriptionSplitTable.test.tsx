import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SubscriptionSplitTable } from "./SubscriptionSplitTable";
import type { SplitLine } from "./subscriptions";
import { billingUnavailable } from "../../lib/plan-cost-status";
import { setLanguage } from "../../lib/i18n";
import type { BillingUnavailableReason } from "../../../shared/plan-price-coverage";

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
