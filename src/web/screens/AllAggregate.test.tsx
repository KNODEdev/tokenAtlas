import { expect, test, spyOn } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AllAggregate } from "./AllAggregate";
import * as asyncState from "../lib/useAsync";
import type { RosterCard } from "../lib/roster";

test("aggregate comparison, history and analytics use roster names without changing history keys", () => {
  const id = "chatgpt-c4d0cf976ebfff8f";
  const slice = { tokens: 100, calls: 2, usd: 5 };
  const data = {
    accounts: [{ id, vendor: "codex", ...slice, first_ts: null, last_ts: null }],
    points: [{ bucket: "2026-09", ...slice, split: { [id]: slice } }],
    totals: slice, notes: [], unpriced: { tokens: 0 },
  };
  const before = JSON.stringify(data);
  const state = spyOn(asyncState, "useAsync").mockReturnValue({ data, loading: false, error: null, reload() {} });
  const cards = [{ id, group: "codex", vendorAccount: "owner@example.com", active: false }] as RosterCard[];
  try {
    for (const screen of ["compare", "history", "analytics"] as const) {
      const html = renderToStaticMarkup(<AllAggregate screen={screen} unit="usd" cards={cards} />);
      expect(html).toContain("owner@example.com");
      expect(html).not.toContain(id);
      expect(html).toContain("$5.00");
      if (screen !== "compare") expect(html).toContain('title="owner@example.com · $5.00"');
    }
    expect(JSON.stringify(data)).toBe(before);
  } finally {
    state.mockRestore();
  }
});

test("a partly priced sum shows its priced part as a lower bound instead of a dash", () => {
  const id = "codex1";
  const slice = { tokens: 1000, calls: 4, usd: null, priced_usd: 147800,
    api_quality: { complete: false as const, conflicts: 0, unpriced_events: 3 } };
  const data = { accounts: [{ id, vendor: "codex", ...slice, first_ts: null, last_ts: null }],
    points: [{ bucket: "2026-08", ...slice, split: { [id]: slice } }, { bucket: "2026-09", ...slice, split: { [id]: slice } }],
    totals: slice, notes: [], unpriced: { tokens: 0 } };
  const state = spyOn(asyncState, "useAsync").mockReturnValue({ data, loading: false, error: null, reload() {} });
  try {
    for (const screen of ["compare", "history", "analytics"] as const) {
      const html = renderToStaticMarkup(<AllAggregate screen={screen} unit="usd" cards={[]} />);
      expect(html).toContain("≥ $147,800.00");
    }
    // Two lower bounds give no period-over-period change.
    expect(renderToStaticMarkup(<AllAggregate screen="analytics" unit="usd" cards={[]} />)).toContain("Partly priced, no change shown");
  } finally {
    state.mockRestore();
  }
});

test("incomplete account-history USD renders without treating a conflict-only zero as a price", () => {
  const id = "claude-seat";
  const slice = { tokens: 0, calls: 1, usd: null, priced_usd: 0,
    api_quality: { complete: false as const, conflicts: 1, unpriced_events: 0 } };
  const data = { accounts: [{ id, vendor: "claude", ...slice, first_ts: null, last_ts: null }],
    points: [{ bucket: "2026-09", ...slice, split: { [id]: slice } }],
    totals: slice, notes: [], unpriced: { tokens: 0 } };
  const state = spyOn(asyncState, "useAsync").mockReturnValue({ data, loading: false, error: null, reload() {} });
  try {
    for (const screen of ["compare", "history", "analytics"] as const) {
      const html = renderToStaticMarkup(<AllAggregate screen={screen} unit="usd" cards={[]} />);
      expect(html).toContain("—");
      expect(html).not.toContain("NaN");
      expect(html).not.toContain("$0.00");
    }
  } finally {
    state.mockRestore();
  }
});

test("the aggregate requests keep their last answer per endpoint and granularity", () => {
  const data = { accounts: [], points: [], totals: { tokens: 0, calls: 0, usd: 0 }, notes: [], unpriced: { tokens: 0 } };
  const state = spyOn(asyncState, "useAsync").mockReturnValue({ data, loading: false, error: null, reload() {} });
  const today = new Date().toISOString().slice(0, 10);
  try {
    const requests = (screen: "compare" | "history" | "analytics") => {
      state.mockClear();
      renderToStaticMarkup(<AllAggregate screen={screen} unit="usd" cards={[]} />);
      return state.mock.calls.map(([, deps, live, retainKey]) => ({ deps, live, retainKey }));
    };
    expect(requests("compare")).toEqual([{ deps: ["month", true], live: false, retainKey: "account-history:month" },
      { deps: [true, today], live: false, retainKey: `claude-account-splits:${today}` }]);
    expect(requests("history")).toEqual([{ deps: ["month", true], live: false, retainKey: "account-history:month" },
      { deps: [true, today], live: false, retainKey: `claude-account-splits:${today}` }]);
    expect(requests("analytics")).toEqual([{ deps: ["month", true], live: false, retainKey: "account-history:month" },
      { deps: [false, today], live: false, retainKey: undefined }]);
  } finally {
    state.mockRestore();
  }
});
