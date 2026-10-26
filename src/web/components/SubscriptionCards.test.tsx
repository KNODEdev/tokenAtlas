import { describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { RosterAccount, RosterProbe, RosterResponse } from "../lib/api";
import { setLanguage } from "../lib/i18n";
import { buildAllCard, buildRoster, groupRoster, type RosterCard } from "../lib/roster";
import { chooseOption, findByAttribute, installTestDom, invoke } from "../lib/test-dom-harness";
import { setMissingRates } from "../lib/missing-rate";
import {
  INACTIVE_EXPANDED_KEY,
  RAIL_ORDER_KEY,
  RAIL_HIDDEN_KEY,
  InactiveGroupLine,
  InactiveSubscriptionCard,
  SubscriptionRail,
  inactiveCountLabel,
} from "./SubscriptionCards";

it("names a ChatGPT card by email and keeps its Windows sources in the tooltip", () => {
  const html = renderToStaticMarkup(<SubscriptionRail cards={cards([{ id: "codex1", vendor_account: "account_0005@example.test",
    vendor_account_source: "observed", account_sources: ["PC / one", "PC / two"] }])} selected="codex1" onSelect={() => {}} />);
  expect(html).toContain("account_0005@example.test");
  expect(html).toContain("Windows sources: PC / one, PC / two");
  expect(html).toContain("account_0005@example.test · codex1");
  expect(html).toContain("OpenAI / Codex");
  expect(html).toMatch(/data-account-subtitle[^>]*>account_0005@example.test<\/div>/);
  expect(html).not.toContain("border-left:3px");
  expect(html).toContain("background:var(--codex)");
});

it("uses plain-language measurement labels and keeps tokens with API-equivalent cost", () => {
  setLanguage("en");
  const measured = { ...cards([{ id: "codex1" }])[0]!, tokensTotal: 621_840_000, usd: 573.32 };
  const measuredHtml = renderToStaticMarkup(<SubscriptionRail cards={[measured]} selected="codex1" onSelect={() => {}} />);
  expect(measuredHtml).toContain(">from account</span>");
  expect(measuredHtml).not.toContain(">gauge</span>");
  expect(measuredHtml).toContain("621.84M tokens");
  expect(measuredHtml).toContain("$573.32</span> API-eq");

  const inferredHtml = renderToStaticMarkup(
    <SubscriptionRail cards={[{ ...measured, basis: "inferred", percentMeasured: false }]} selected="codex1" onSelect={() => {}} />
  );
  expect(inferredHtml).toContain(">estimate</span>");
  expect(inferredHtml).not.toContain(">inferred</span>");
});

it("filters providers and restores a custom account order after remount", async () => {
  setLanguage("en");
  const { host, restore } = installTestDom();
  const prototype = Object.getPrototypeOf(host);
  prototype.showModal = function () { this.setAttribute("open", ""); };
  prototype.close = function () { this.removeAttribute("open"); };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  } });
  const root = createRoot(host as unknown as Element);
  const rows = cards([{ id: "codex1" }, { id: "codex2" }, { id: "claude1", vendor: "claude" }]);
  rows[2] = { ...rows[2]!, group: "claude", vendor: "claude" };
  const render = () => root.render(<SubscriptionRail cards={rows} selected="codex1" onSelect={() => {}} />);
  try {
    await act(async () => render());
    await chooseOption(findByAttribute(host, "data-provider-filter", "true")!, "claude");
    expect(findByAttribute(host, "data-subscription", "codex1")).toBeNull();
    expect(findByAttribute(host, "data-subscription", "claude1")).not.toBeNull();
    await chooseOption(findByAttribute(host, "data-provider-filter", "true")!, "all");
    expect(findByAttribute(host, "aria-label", "Move up: codex2")).toBeNull();
    await invoke(findByAttribute(host, "data-rail-settings", "true")!, "onClick");
    expect(findByAttribute(host, "aria-labelledby", "rail-settings-title")).not.toBeNull();
    await invoke(findByAttribute(host, "aria-label", "Move up: codex2")!, "onClick");
    expect(JSON.parse(store.get(RAIL_ORDER_KEY)!)).toEqual(["card:codex2", "card:codex1"]);
    await invoke(findByAttribute(host, "aria-label", "Close subscription settings")!, "onClick");
    expect(findByAttribute(host, "aria-labelledby", "rail-settings-title")).toBeNull();
    await act(async () => root.render(null));
    await act(async () => render());
    const first = findByAttribute(host, "data-subscription", "codex2")!;
    const second = findByAttribute(host, "data-subscription", "codex1")!;
    expect(first.parentNode).toBe(second.parentNode);
    expect(first.parentNode!.children.indexOf(first)).toBeLessThan(first.parentNode!.children.indexOf(second));
    await invoke(findByAttribute(host, "data-rail-settings", "true")!, "onClick");
    const dragEvent = { dataTransfer: { setData: () => {} }, preventDefault: () => {}, stopPropagation: () => {} };
    await invoke(findByAttribute(host, "data-drag-handle", "card:codex1")!, "onDragStart", dragEvent);
    await invoke(findByAttribute(host, "data-drop-row", "card:codex2")!, "onDrop", dragEvent);
    expect(JSON.parse(store.get(RAIL_ORDER_KEY)!)).toEqual(["card:codex1", "card:codex2"]);
    await invoke(findByAttribute(host, "data-visibility", "card:codex1")!, "onChange");
    expect(findByAttribute(host, "data-subscription", "codex1")).toBeNull();
    expect(findByAttribute(host, "data-visibility", "card:codex1")).not.toBeNull();
    expect(JSON.parse(store.get(RAIL_HIDDEN_KEY)!)).toEqual(["card:codex1"]);
    await act(async () => root.render(null));
    await act(async () => render());
    expect(findByAttribute(host, "data-subscription", "codex1")).toBeNull();
    await invoke(findByAttribute(host, "data-rail-settings", "true")!, "onClick");
    await invoke(findByAttribute(host, "data-visibility", "card:codex1")!, "onChange");
    expect(findByAttribute(host, "data-subscription", "codex1")).not.toBeNull();
    await invoke(findByAttribute(host, "data-visibility", "group:codex")!, "onChange");
    expect(findByAttribute(host, "data-subscription", "codex1")).toBeNull();
    expect(findByAttribute(host, "data-subscription", "codex2")).toBeNull();
    expect(findByAttribute(host, "data-subscription", "claude1")).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
    restore();
  }
});

function account(over: Partial<RosterAccount>): RosterAccount {
  return {
    id: "codex1",
    vendor: "codex",
    plan: "plus",
    label: "codex1 (plus)",
    capabilities: {
      hasGaugeSeries: true,
      hasTokenDetail: true,
      hasCalibration: false,
      hasSecondWindow: false,
      reportsSide: "used",
      unit: "token",
    },
    has_gauge: true,
    active: true,
    vendor_account: null,
    vendor_account_source: null,
    first_seen: null,
    last_seen: null,
    cycle_count: 0,
    probe: null,
    live: {
      account: "codex1",
      limit_id: "codex",
      limit_name: null,
      plan_type: "plus",
      slot: "primary",
      window_minutes: 10_080,
      used_percent: 40,
      resets_at: Math.floor(Date.now() / 1000) + 24 * 3_600,
      resets_at_iso: null,
      rate_limit_reached: false,
      reset_credits: 0,
      ts: new Date().toISOString(),
      age_minutes: 3,
      machine: null,
    },
    live_other: [],
    basis: "gauge",
    note: null,
    gauge_age_hours: 0,
    empty_reason: null,
    cycles: [],
    shadow: null,
    claude: null,
    gemini: null,
    grok: null,
    glm: null,
    ...over,
  };
}

const CLOSED = {
  active: false,
  first_seen: "2026-03-04T08:00:00.000Z",
  last_seen: "2026-06-19T21:30:00.000Z",
  cycle_count: 15,
  probe: null,
  live: null,
} satisfies Partial<RosterAccount>;

function cards(rows: Partial<RosterAccount>[]): RosterCard[] {
  const res: RosterResponse = {
    window_minutes: 10_080,
    count: rows.length,
    accounts: rows.map(account),
  };
  return buildRoster(res);
}

/** The rail reads its expansion state on mount; drive it from a stub store. */
function withStoredExpansion<T>(value: string | null, fn: () => T): T {
  const store = new Map<string, string>();
  if (value != null) store.set(INACTIVE_EXPANDED_KEY, value);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  try {
    return fn();
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

describe("roster grouping by vendor", () => {
  it("splits each vendor section into active and archived subscriptions", () => {
    const groups = groupRoster(
      cards([
        { id: "codex1" },
        { id: "codex2", ...CLOSED },
        { id: "claude", vendor: "claude", basis: "declared", live: null },
      ])
    );
    expect(groups.map((g) => g.key)).toEqual(["codex", "claude"]);
    expect(groups[0]!.active.map((c) => c.id)).toEqual(["codex1"]);
    expect(groups[0]!.inactive.map((c) => c.id)).toEqual(["codex2"]);
    expect(groups[1]!.inactive).toEqual([]);
  });

  it("keeps a vendor section that has nothing but archived subscriptions", () => {
    const groups = groupRoster(cards([{ id: "codex1" }, { id: "grok", vendor: "grok", basis: "spend", ...CLOSED }]));
    const grok = groups.find((g) => g.key === "grok");
    expect(grok).toBeDefined();
    expect(grok!.active).toEqual([]);
    expect(grok!.inactive.map((c) => c.id)).toEqual(["grok"]);
  });
});

describe("portfolio aggregate", () => {
  it("counts only active subscriptions", () => {
    const all = buildAllCard(
      cards([
        { id: "codex1", live: { ...account({}).live!, used_percent: 40 } },
        { id: "codex2", live: { ...account({}).live!, used_percent: 60 } },
        { id: "codex3", ...CLOSED },
      ])
    );
    expect(all.plan).toBe("2 subscriptions");
    expect(all.usedPercent).toBe(50);
  });
});

describe("archive line", () => {
  it("declines the badge word for the count", () => {
    try {
      setLanguage("en");
      expect(inactiveCountLabel(1)).toBe("1 inactive");
      expect(inactiveCountLabel(3)).toBe("3 inactive");
      expect(inactiveCountLabel(5)).toBe("5 inactive");
      expect(inactiveCountLabel(12)).toBe("12 inactive");
      expect(inactiveCountLabel(22)).toBe("22 inactive");

      setLanguage("pl");
      expect(inactiveCountLabel(1)).toBe("1 nieaktywna");
      expect(inactiveCountLabel(3)).toBe("3 nieaktywne");
      expect(inactiveCountLabel(5)).toBe("5 nieaktywnych");
      expect(inactiveCountLabel(12)).toBe("12 nieaktywnych");
      expect(inactiveCountLabel(22)).toBe("22 nieaktywne");
    } finally {
      setLanguage("en");
    }
  });

  it("collapses the archive by default and names how many are behind it", () => {
    const html = withStoredExpansion(null, () =>
      renderToStaticMarkup(
        <SubscriptionRail
          cards={cards([{ id: "codex1" }, { id: "codex2", ...CLOSED }, { id: "codex3", ...CLOSED }])}
          selected="codex1"
          onSelect={() => {}}
        />
      )
    );
    expect(html).toContain('data-inactive-line="2"');
    expect(html).toContain("2 inactive");
    expect(html).not.toContain("data-inactive-card");
  });

  it("expands from the persisted per-vendor state", () => {
    const html = withStoredExpansion(JSON.stringify({ codex: true }), () =>
      renderToStaticMarkup(
        <SubscriptionRail
          cards={cards([{ id: "codex1" }, { id: "codex2", ...CLOSED }])}
          selected="codex1"
          onSelect={() => {}}
        />
      )
    );
    expect(html).toContain('data-inactive-card="codex2"');
  });

  it("survives a storage read that throws or holds junk", () => {
    for (const stored of [null, "not json", '["codex"]']) {
      const html = withStoredExpansion(stored, () =>
        renderToStaticMarkup(
          <SubscriptionRail
            cards={cards([{ id: "codex1" }, { id: "codex2", ...CLOSED }])}
            selected="codex1"
            onSelect={() => {}}
          />
        )
      );
      expect(html).toContain("data-inactive-line");
      expect(html).not.toContain("data-inactive-card");
    }
  });

  it("reports its toggle to the caller", async () => {
    let toggles = 0;
    const { host, restore } = installTestDom();
    const root = createRoot(host as unknown as Element);
    try {
      await act(async () => {
        root.render(<InactiveGroupLine count={2} expanded={false} onToggle={() => void toggles++} />);
      });
      const line = findByAttribute(host, "data-inactive-line", "2");
      expect(line).not.toBeNull();
      await invoke(line!, "onClick");
      expect(toggles).toBe(1);
    } finally {
      await act(async () => root.unmount());
      restore();
    }
  });
});

describe("archived card", () => {
  const archived = cards([{ id: "codex2", vendor_account: "account_0001@example.test", ...CLOSED }])[0]!;

  it("is a full selection, exactly like an active card", async () => {
    const picked: string[] = [];
    const { host, restore } = installTestDom();
    const root = createRoot(host as unknown as Element);
    try {
      await act(async () => {
        root.render(
          <InactiveSubscriptionCard
            card={archived}
            selected={false}
            onSelect={(id) => void picked.push(id)}
          />
        );
      });
      const card = findByAttribute(host, "data-inactive-card", "codex2");
      expect(card).not.toBeNull();
      await invoke(card!, "onClick");
      expect(picked).toEqual(["codex2"]);
    } finally {
      await act(async () => root.unmount());
      restore();
    }
  });

  it("shows the badge, the observed span and the cycle count, but no live percent or pace bar", () => {
    const html = renderToStaticMarkup(
      <InactiveSubscriptionCard card={archived} selected={false} onSelect={() => {}} />
    );
    expect(html).toContain("inactive");
    expect(html).toContain("2026-03-04 → 2026-06-19");
    expect(html).toContain("15 cycles");
    expect(html).toContain("account_0001@example.test");
    expect(html).not.toContain("data-reset-time");
    // no rendered percent (border-radius:50% in the style attribute is not one) and no pace ratio
    expect(html).not.toMatch(/>\s*[\d.]+%/);
    expect(html).not.toMatch(/>\s*[\d.]+×/);
  });

  it("carries the selected treatment when it is the chosen subscription", () => {
    const html = renderToStaticMarkup(
      <InactiveSubscriptionCard card={archived} selected onSelect={() => {}} />
    );
    expect(html).toContain('aria-pressed="true"');
  });
});

describe("vendor account subtitle", () => {
  it("shows a declared account once", () => {
    const html = renderToStaticMarkup(
      <SubscriptionRail
        cards={cards([{ id: "codex1", vendor_account: "account_0001@example.test", vendor_account_source: "declared" }])}
        selected="codex1"
        onSelect={() => {}}
      />
    );
    expect(html).toContain("data-account-subtitle");
    expect(html).toContain("account_0001@example.test");
    expect(html).not.toContain("data-vendor-account");
  });

  it("keeps an observed-only identity as the account subtitle", () => {
    const html = renderToStaticMarkup(
      <SubscriptionRail
        cards={cards([
          { id: "codex1", vendor_account: "account_0003@example.test", vendor_account_source: "observed" },
        ])}
        selected="codex1"
        onSelect={() => {}}
      />
    );
    expect(html).toContain(">account_0003@example.test</div>");
  });

  it("falls back to the subscription id when no vendor identity exists", () => {
    const html = renderToStaticMarkup(
      <SubscriptionRail cards={cards([{ id: "codex1" }])} selected="codex1" onSelect={() => {}} />
    );
    expect(html).toContain("data-account-subtitle");
    expect(html).toContain(">codex1</div>");
  });
});

function probe(over: Partial<RosterProbe>): RosterProbe {
  return {
    provider: "codex",
    subject: "codex1",
    state: "none",
    fresh_minutes: 15,
    reading: null,
    machines: [],
    ...over,
  };
}

function rail(rows: Partial<RosterAccount>[]): string {
  return renderToStaticMarkup(
    <SubscriptionRail cards={cards(rows)} selected="codex1" onSelect={() => {}} />
  );
}

describe("three probe states on the card", () => {
  it("state 1 — a fresh percent keeps full emphasis and names the reading machine", () => {
    const html = rail([
      {
        probe: probe({
          state: "fresh",
          reading: { ts: new Date().toISOString(), age_minutes: 4, machine: "EXAMPLE-MAIN" },
          machines: [
            { machine: "EXAMPLE-MAIN", last_ok_ts: new Date().toISOString(), last_error_ts: null, last_error: null },
          ],
        }),
      },
    ]);
    expect(html).toContain('data-probe="fresh"');
    expect(html).toContain("reading 4 min ago");
    expect(html).toContain("by EXAMPLE-MAIN");
    expect(html).toContain("40%");
    expect(html).not.toContain("data-probe-trail");
  });

  it("state 2 — a stale percent is de-emphasised and says where the reading came from", () => {
    const now = Date.now();
    const html = rail([
      {
        probe: probe({
          state: "stale",
          reading: { ts: new Date(now - 900 * 60_000).toISOString(), age_minutes: 900, machine: "EXAMPLE-MAIN" },
          machines: [
            {
              machine: "EXAMPLE-MAIN",
              last_ok_ts: new Date(now - 900 * 60_000).toISOString(),
              last_error_ts: null,
              last_error: null,
            },
            {
              machine: "EXAMPLE-LAPTOP-A",
              last_ok_ts: null,
              last_error_ts: "2026-08-30T09:00:00.000Z",
              last_error: "auth.json missing",
            },
          ],
        }),
      },
    ]);
    expect(html).toContain('data-probe="stale"');
    expect(html).toContain("last reading 15.0 h ago");
    expect(html).toContain("from EXAMPLE-MAIN");
    expect(html).toContain("40%");
    expect(html).toContain("data-probe-trail");
    expect(html).toContain("EXAMPLE-LAPTOP-A - probe error since 08/30");
    // greyed, not merely a different hue: the percent drops to the muted token
    expect(html).toContain('class="sub-card-pct is-stale"');
  });

  it("state 3 — no percent anywhere shows the reason instead of a number", () => {
    const html = rail([
      {
        live: null,
        probe: probe({
          state: "none",
          machines: [
            {
              machine: "EXAMPLE-MAIN",
              last_ok_ts: null,
              last_error_ts: "2026-08-30T09:00:00.000Z",
              last_error: "auth.json missing",
            },
            {
              machine: "EXAMPLE-LAPTOP-A",
              last_ok_ts: null,
              last_error_ts: "2026-09-01T09:00:00.000Z",
              last_error: "pula Gemini nie jest dostępna na tej maszynie",
            },
          ],
        }),
      },
    ]);
    expect(html).toContain('data-probe="none"');
    expect(html).toContain("no machine is probing this subscription");
    expect(html).toContain("EXAMPLE-MAIN - probe error since 08/30 (auth.json missing)");
    expect(html).toContain("EXAMPLE-LAPTOP-A - probe error since 09/01");
    expect(html).not.toMatch(/>\s*\d+%\s*</);
  });

  it("never lets a raw vendor error be the whole card", () => {
    const html = rail([
      {
        live: null,
        probe: probe({
          state: "none",
          machines: [
            {
              machine: "EXAMPLE-MAIN",
              last_ok_ts: null,
              last_error_ts: "2026-08-30T09:00:00.000Z",
              last_error: "TypeError: Cannot read properties of undefined (reading 'usage')",
            },
          ],
        }),
      },
    ]);
    const trail = html.slice(html.indexOf("data-probe-trail"));
    expect(trail).toContain("EXAMPLE-MAIN - probe error since 08/30");
    expect(html.indexOf("no machine is probing this subscription")).toBeLessThan(
      html.indexOf("TypeError")
    );
  });
});

describe("Grok card without a Billing reading", () => {
  const grokWindow = (percentEst: number | null, turns: number): Partial<RosterAccount> => {
    const now = Date.now();
    const start = new Date(now - 2 * 24 * 3_600_000).toISOString();
    const reset = new Date(now + 5 * 24 * 3_600_000).toISOString();
    return {
      id: "grok",
      vendor: "grok",
      basis: "spend",
      live: null,
      grok: {
        window_hours: 168,
        anchored: false,
        since_ts: start,
        until_ts: reset,
        spend: { turns, calls: turns * 4, gross: 100, fresh: 40, cached: 60, out: 10, reasoning: 0, usd: 12.5 },
        models: [],
        first_ts: start,
        last_ts: new Date(now).toISOString(),
        age_hours: 0,
        usd_basis: "vendor",
        ticks_per_usd: 1_000_000_000,
        limit: {
          configured: true,
          plan: "SuperGrok",
          window_hours: 168,
          observations: [],
          calibration: null,
          current: {
            window_start: start,
            window_end: reset,
            anchored: true,
            anchor_ts: start,
            reset_in_hours: 120,
            spend: { turns, calls: turns * 4, gross: 100, fresh: 40, usd: 12.5 },
            percent_measured: null,
            measured_at: null,
            measurement_age_minutes: null,
            measurement_source: null,
            percent_est: percentEst,
            remaining_usd: null,
            idle_hours: 0,
          },
          caveats: [],
        },
      },
    };
  };

  it("labels an estimate and prints it smaller than a measured percent", () => {
    const html = renderToStaticMarkup(
      <SubscriptionRail cards={cards([grokWindow(17, 29)])} selected="grok" onSelect={() => {}} />
    );
    expect(html).toContain("data-estimate");
    expect(html).toContain("estimate 17%");
    expect(html).toMatch(/data-estimate[^>]*class="sub-card-estimate"/);
  });

  it("shows no percent and no 0% when the window holds no indexed traffic", () => {
    const html = renderToStaticMarkup(
      <SubscriptionRail
        cards={cards([
          {
            ...grokWindow(null, 0),
            probe: probe({
              provider: "grok",
              subject: "grok",
              state: "none",
              machines: [
                {
                  machine: "EXAMPLE-LAPTOP-A",
                  last_ok_ts: null,
                  last_error_ts: "2026-09-01T09:00:00.000Z",
                  last_error: "resolveAt zwrócił null",
                },
              ],
            }),
          },
        ])}
        selected="grok"
        onSelect={() => {}}
      />
    );
    expect(html).not.toContain("data-estimate");
    expect(html).not.toMatch(/>\s*[\d.]+%\s*</);
    expect(html).not.toContain("Inferred");
    expect(html).toContain("no machine is probing this subscription");
  });
});

describe("an amount with tokens of a model without a price", () => {
  const summary = { tokens: 2_300_000_000, models: [{ model: "gpt-new-sol", observed_provider: "openai", rate_vendor: "openai", tokens: 2_300_000_000 }] };
  const render = (card: RosterCard) => renderToStaticMarkup(<SubscriptionRail cards={[card]} selected={card.id} onSelect={() => {}} />);
  const base = { ...cards([{ id: "codex1" }])[0]!, tokensTotal: 3_000_000_000, usd: 412.5 };

  it("shows the priced part followed by a no-price marker naming the model in its tooltip", () => {
    setLanguage("pl");
    setMissingRates(summary);
    try {
      const html = render({ ...base, unpricedModels: [{ model: "gpt-new-sol", tokens: 2_300_000_000 }, { model: "codex-auto-review", tokens: 10 }] });
      expect(html).toContain("$412,50</span>");
      expect(html).toMatch(/data-missing-rate[^>]*> \+ brak ceny<\/span>/);
      expect(html).toContain("Kwota niepełna. Brak ceny w cenniku dla: gpt-new-sol (2,3 mld tokenów)");
      expect(html).toContain("Wpisz cenę w Ustawieniach → Cenniki → Modele.");
    } finally { setMissingRates(null); setLanguage("en"); }
  });

  it("says no price instead of $0.00 when nothing in the window is priced", () => {
    setMissingRates(summary);
    try {
      const html = render({ ...base, usd: 0, unpricedModels: [{ model: "gpt-new-sol", tokens: 5 }] });
      expect(html).toMatch(/data-missing-rate[^>]*>no price<\/span> API-eq/);
      expect(html).not.toContain("$0.00");
    } finally { setMissingRates(null); }
  });

  it("adds nothing for a known-unpriced model or before the summary is read", () => {
    setMissingRates(summary);
    try {
      const known = render({ ...base, usd: 0, unpricedModels: [{ model: "codex-auto-review", tokens: 5 }] });
      expect(known).not.toContain("data-missing-rate");
      expect(known).toContain("$0.00</span> API-eq");
    } finally { setMissingRates(null); }
    expect(render({ ...base, unpricedModels: [{ model: "gpt-new-sol", tokens: 5 }] })).not.toContain("data-missing-rate");
  });
});

describe("credit pool block", () => {
  const grantPools = {
    read_at: "2026-10-09T12:00:00.000Z",
    pools: [{ key: "claude:iguana_necktie", kind: "grant" as const, unit: "usd" as const, granted: 250, used: 8.1, remaining: 241.9,
      remaining_text: null, unlimited: false, granted_at: null, expires_at: "2026-11-05T12:00:00.000Z", items: null }],
    flows: [{ key: "claude:iguana_necktie", unit: "usd" as const, since: "2026-10-08T12:00:00.000Z", start_remaining: 249.82,
      end_remaining: 241.9, spent: 7.92, added: 0, expired: 0 }],
  };
  const claudeCard = (credit_pools?: typeof grantPools) => cards([{ id: "claude-a", vendor: "claude", live: null, basis: "declared",
    claude: { window_hours: 168, current: null, session: null, confidence: "none", calibration_reason: null, usd_per_point: null,
      window_value_usd: null, caveat_count: 0, ...(credit_pools ? { credit_pools } : {}) } }])[0]!;
  const render = (card: RosterCard) => renderToStaticMarkup(<SubscriptionRail cards={[card]} selected="" onSelect={() => {}} />);
  const codexPools: NonNullable<RosterCard["creditPools"]> = {
    read_at: "2026-10-10T07:31:00.000Z",
    pools: [
      { key: "codex:credits", kind: "balance", unit: "credits", granted: null, used: null, remaining: 60749.9557035,
        remaining_text: "60749.9557035000", unlimited: false, granted_at: null, expires_at: null, items: null },
      { key: "codex:resets", kind: "resets", unit: "resets", granted: null, used: null, remaining: 3, remaining_text: null, unlimited: false,
        granted_at: null, expires_at: "2026-10-22T10:00:00.000Z", items: [] },
    ],
    flows: [{ key: "codex:credits", unit: "credits", since: "2026-10-09T12:00:00.000Z", start_remaining: 60749.9557035,
      end_remaining: 60749.9557035, spent: 0, added: 0, expired: 0 }],
  };
  const basis = { start: "2026-09-26T16:58:00.000Z", end: "2026-10-03T09:22:00.000Z", credits: 39061.54, usd: 2065.4, tokens: 4.78e9, partial: false };

  it("shows the current window's pool under the card and nothing for a card without one", () => {
    setLanguage("pl");
    try {
      const withPool = render(claudeCard(grantPools));
      const without = render(claudeCard());
      expect(withPool).toContain("data-credit-pools");
      expect(withPool).toContain(">grant · <span class=\"sub-card-pool-amount ui-figure\">zostało $241,90</span></span>");
      expect(withPool).toContain("przyznano $250,00 · zużyto $8,10");
      expect(withPool).not.toContain("wydano $7,92 w tym oknie");
      expect(withPool).toContain("wygasa 05.11");
      expect(withPool).toMatch(/sub-card-pool-bar" title="[^"]+"><i style="width:96.76%"><\/i><\/span>/);
      expect(without).not.toContain("data-credit-pools");
      expect(without).not.toContain("sub-card-pool");
      // The block is the only difference: the rest of the card stays as it was.
      expect(withPool.replace(/<div data-credit-pools.*?<\/div><\/div><\/button>/, "</button>")).toBe(without);
    } finally { setLanguage("en"); }
  });

  it("Codex uses the shared pool facts, retaining conversion and separating observed charges from valued calls", () => {
    setLanguage("pl");
    try {
      const base = cards([{ id: "codex1" }])[0]!;
      const html = render({ ...base, usedPercent: 88, creditPools: codexPools, creditBasis: basis });
      expect(html).toContain('data-pool="codex:credits"');
      expect(html).toContain('>kredyty <span class="sub-card-pool-amount ui-figure">60 750</span></span>');
      expect(html).toContain("≈ 1,6 okna · ≈ $3212");
      expect(html).toMatch(/sub-card-pool-bar" title="[^"]+"><i style="width:77.76%">/);
      expect(html).toContain("<span class=\"sub-card-pool-dots\"><i></i><i></i><i></i></span>3 darmowe resety");
      expect(html).toContain("najbliższy do 22.10");
      expect(html).not.toContain("wydano");
      expect(html).not.toContain("is-credit");
      const paying = render({ ...base, usedPercent: 100, creditPools: codexPools, creditBasis: basis, creditFunded: { calls: 3127, tokens: 549e6,
        credits: 4500.2, credits_unpriced: 0, api_standard: 238, api_unpriced: 0, first: "2026-10-01T08:00:00.000Z", last: "2026-10-02T20:00:00.000Z", hours: [] } });
      expect(paying).toContain("wycena wywołań z puli 4500,2 kr.");
      expect(paying).toContain("wydatek konta w tym oknie 0 kr.");
      const visible = paying.replace(/ title="[^"]*"/g, "");
      expect(visible).not.toContain("wydatek konta w tym oknie");
      expect(visible).not.toContain("wycena wywołań z puli");
      expect(paying).not.toContain("teraz płacisz kredytami");
      // Without a full window the balance stays bare: no conversion, no bar.
      const bare = render({ ...base, usedPercent: 40, creditPools: codexPools, creditBasis: null });
      expect(bare).not.toContain("okna ·");
      expect(bare).not.toContain("sub-card-pool-bar");
    } finally { setLanguage("en"); }
  });
});
