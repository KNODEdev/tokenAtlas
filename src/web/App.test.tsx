import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RemapFailureBadge, overviewCycleSubtitle, seriesRailFacts, shouldRenderLegacyCycleDetail } from "./App";
import { ALL_ACCOUNT, selectedAccountId } from "./lib/roster";
import { Sidebar } from "./components/Sidebar";
import { emptyModel } from "./lib/cycle";
import type { CycleView } from "./lib/cycle";
import { dayTime } from "./lib/format";
import { shouldReadWindowRail, type ScreenProps } from "./lib/screens";
import { Capacity } from "./screens/Capacity";
import { Models } from "./screens/Models";
import { History } from "./screens/History";
import { Settings } from "./screens/Settings";
const emptySeries = {
  account: "codex1",
  window_minutes: 10080,
  limit_id: "codex",
  sample_count: 0,
  bucket_minutes: 0,
  first_ts: null,
  last_ts: null,
  points: [],
  cycles: [],
  latest: null,
  stats: null,
};
function settingsProps(): ScreenProps {
  return {
    model: emptyModel("codex1", 10080),
    unit: "percent",
    setUnit: () => {},
    account: "codex1",
    selectAccount: () => {},
    accounts: [],
    capabilities: null,
    card: null,
    project: "",
    setProject: () => {},
    projects: [],
    chosen: null,
    selectCycle: () => {},
    openDrawer: () => {},
    windowRailInShell: false,
    goto: () => {},
    compare: [],
    setCompare: () => {},
    sync: null,
    triggerSync: () => {},
  };
}
describe("initial account selection", () => {
  it("preserves a declared selection and resolves a missing startup default to a configured account", () => {
    expect(selectedAccountId("codex1", ["indexed-a", "indexed-b"])).toBe("indexed-a");
    expect(selectedAccountId("codex1", ["indexed-a", "codex1"])).toBe("codex1");
    expect(selectedAccountId("indexed-b", ["indexed-a", "indexed-b"])).toBe("indexed-b");
    expect(selectedAccountId(ALL_ACCOUNT, ["indexed-a", "indexed-b"])).toBe(ALL_ACCOUNT);
    expect(selectedAccountId("codex1", [])).toBe("codex1");
  });
});

describe("empty usage-series latest: null", () => {
  it("does not throw on latest.ts / latest.age_hours and keeps Settings reachable", () => {
    expect(() => seriesRailFacts(emptySeries)).not.toThrow();
    expect(seriesRailFacts(emptySeries)).toEqual({ lastSync: null, calls: null, live: false });
    const status = {
      cycleBadge: undefined as string | undefined,
      cycleCount: undefined as number | undefined,
      ...seriesRailFacts(emptySeries),
    };
    const chrome = renderToStaticMarkup(
      <Sidebar
        screen="settings"
        goto={() => {}}
        collapsed={false}
        onToggleCollapse={() => {}}
        status={status}
      />
    );
    expect(chrome).toContain("Settings");
    expect(chrome).toContain("No fresh data");
    const body = renderToStaticMarkup(<Settings {...settingsProps()} />);
    expect(body).toContain("Accounts");
    expect(body).toContain("Price lists");
  });
  it("still reports a live sample when latest is present and fresh", () => {
    expect(
      seriesRailFacts({
        latest: { ts: "2026-08-28T12:00:00Z", age_hours: 1.5 },
        stats: { total_calls: 12 },
      })
    ).toEqual({ lastSync: "2026-08-28T12:00:00Z", calls: 12, live: true });
  });
});

describe("remap failure diagnostics", () => {
  it("redacts hostile paths and stack frames from the remap error tooltip", () => {
    const html = renderToStaticMarkup(
      <RemapFailureBadge
        logTail={[
          "Failed C:\\Users\\Alice Smith\\Private Data\\atlas.db",
          "manifest /home/alice/private/snapshot.json",
          "    at remap (/opt/token-atlas/src/remap.ts:12:4)",
          "safe code: remap-failed",
        ]}
      />
    );
    expect(html).toContain("remap error");
    expect(html).toContain("[ścieżka ukryta]");
    expect(html).toContain("remap-failed");
    for (const secret of ["Alice Smith", "Private Data", "/home/alice", "/opt/token-atlas", "at remap"]) {
      expect(html).not.toContain(secret);
    }
  });
});

describe("shared window screens", () => {
  it("keeps the richer Codex cycle detail alongside shared history and comparison", () => {
    expect(shouldRenderLegacyCycleDetail("history", true, false)).toBe(true);
    expect(shouldRenderLegacyCycleDetail("compare", true, false)).toBe(true);
    expect(shouldRenderLegacyCycleDetail("history", false, true)).toBe(false);
  });

  it("keeps the window rail out of subscription history", () => {
    expect(shouldReadWindowRail("overview")).toBe(true);
    expect(shouldReadWindowRail("compare")).toBe(true);
    expect(shouldReadWindowRail("history")).toBe(false);
  });

  it("opens the limit windows, not an empty cycle list, for accounts without cycles", () => {
    const html = renderToStaticMarkup(
      <History {...settingsProps()} windowsView={<div>window-history-marker</div>} />
    );
    expect(html).toContain("window-history-marker");
    expect(html).not.toContain("No registered cycles");
    // Decision 2: a window's events open from its panel, not from a History tab.
    expect(html).not.toContain('role="tab"');
    expect(html).not.toContain(">Events<");
  });

  it("shows the cycle archive when there is no window view", () => {
    const html = renderToStaticMarkup(<History {...settingsProps()} />);
    expect(html).toContain("No registered cycles");
    expect(html).not.toContain(">Events<");
  });
});

describe("selected Overview cycle context", () => {
  it("labels a historical cycle as closed, includes its dated plan, and uses work_to_ts", () => {
    const workTo = "2026-08-07T18:00:00.000Z";
    const nominalReset = "2026-08-08T00:00:00.000Z";
    const cycle = {
      label: "Cycle #4",
      isActive: false,
      startIso: "2026-08-01T00:00:00.000Z",
      endIso: nominalReset,
      elapsedPercent: 100,
      raw: { work_to_ts: workTo, plan_types: ["pro"] },
    } as unknown as CycleView;
    const subtitle = overviewCycleSubtitle(cycle, (en) => en);
    expect(subtitle).toContain("Cycle #4 · closed");
    expect(subtitle).toContain("Pro · ×20");
    expect(subtitle).toContain(dayTime(workTo));
    expect(subtitle).not.toContain(dayTime(nominalReset));
    expect(subtitle).not.toContain("~");
  });

  it("shows mixed historical plan terms without guessing their chronology", () => {
    const cycle = {
      label: "Cycle #39",
      isActive: false,
      startIso: "2026-07-10T00:52:00.000Z",
      endIso: "2026-07-17T00:52:00.000Z",
      elapsedPercent: 100,
      raw: { work_to_ts: "2026-07-17T00:52:00.000Z", plan_types: ["prolite", "pro"] },
    } as unknown as CycleView;
    const subtitle = overviewCycleSubtitle(cycle, (en) => en);
    expect(subtitle).toContain("Pro · ×5 / Pro · ×20 · plan change");
  });
});

describe("capacity navigation", () => {
  it("places capacity under Limits and keeps all-account capacity scoped", () => {
    const html = renderToStaticMarkup(<Sidebar screen="capacity" goto={() => {}} collapsed={false} onToggleCollapse={() => {}} status={{ lastSync: null, calls: null, live: false }} />);
    expect(html).toContain('aria-label="Limits" aria-current="page"'); expect(html).toContain("Models");
    const all = renderToStaticMarkup(<Capacity cards={[]} {...settingsProps()} account="all" />);
    expect(all).toContain("Global subscription capacity"); expect(all).toContain("Subscriptions and cycles");
  });
  it("opens model usage without capacity tabs and explains Business allowance", () => {
    // The page tab names the view, so the stats card shows no inner tab of its own.
    const models = renderToStaticMarkup(<Models {...settingsProps()} />);
    expect(models).toContain("See which models, modes and computers contributed to the recorded usage.");
    expect(models).not.toContain('role="tablist"');
    expect(models).not.toContain("Per 1% over time");
    const traffic = renderToStaticMarkup(<Models {...settingsProps()} view="trends" />);
    // Its help sits on the chart title; the period controls share the scope row instead of a head band.
    expect(traffic).not.toContain("stats-head\"");
    expect(traffic).toContain("Analysis period");
    expect(traffic).not.toContain('role="tablist"');
    const business = renderToStaticMarkup(<Capacity cards={[]} {...settingsProps()} account="personal::business" accounts={[{ id: "personal::business", vendor: "codex", plan: null, login: null, machine: null, note: null, homes: [], ratelimit_rows: 0, event_rows: 0, windows: [], limit_ids: [], first_event_ts: null, last_event_ts: null, has_gauge: false, has_events: true }]} />);
    expect(business).toContain("Business uses credits");
    expect(business).not.toContain("Loading");
  });
});
