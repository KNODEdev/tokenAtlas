import { afterEach, describe, expect, it, jest, spyOn } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { act } from "react";
import { preserveBrowserGlobals } from "../lib/test-dom-globals";
let restoreDom = () => {};
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  api,
  type CapacityEquivalents,
  type ProjectCostResponse,
  type Provenance,
  type SubjectCost,
  type SubjectRow,
  type SubjectSubscriptionSlice,
} from "../lib/api";
import { agentParallelism, ProjectTiles, ProjectUsage, rankingCostOf, SubjectRowView, costForRequest, sortSubjects } from "./ProjectUsage";

const cost: ProjectCostResponse = {
  since: "2026-08-01",
  until: null,
  subscriptions: [],
  subjects: [],
  totals: {
    tokens: 0,
    calls: 0,
    api_usd: 0,
    paid_usd: 0,
    billed_usd: 0,
    unassigned_billed_usd: 0,
    unassigned_api_usd: 0,
    non_tmp_tokens: 0,
  },
  unpriced: { tokens: 0, models: {} },
  coverage: {
    tmp_bucket: { tokens: 0, calls: 0, api_usd: 0, billed_usd: 0 },
    unassigned: { tokens: 0, calls: 0, api_usd: 0, billed_usd: 0 },
    unpriced: { tokens: 0, calls: 0, api_usd: null, billed_usd: null, models: {} },
    unattributable: { tokens: 0, calls: 0, api_usd: null, billed_usd: null, vendor: "gemini" },
    totals: { tokens: 0, calls: 0, api_usd: 0, billed_usd: 0 },
  },
  notes: [],
};

const row: SubjectRow = {
  kind: "project",
  id: "alpha",
  name: "Alpha",
  group: null,
  tokens: 100,
  calls: 2,
  active_seconds: 3600,
  repos: [],
};

const absentEq = { value: null, absent: "no_capacity" } as const;
const rankingEquivalents: CapacityEquivalents = {
  full_5h_sessions: absentEq,
  weekly_cycles: absentEq,
  monthly_subscriptions: absentEq,
};
const rankingProvenance: Provenance = {
  capacity: "none",
  price: "none",
  cadence: "none",
  calibration_covers_period: false,
  coverage: "none",
  measured_share: 0,
};

function rankingSlice(billed: number | null, apiUsd = 10): SubjectSubscriptionSlice {
  return {
    tokens: 100,
    api_usd: apiUsd,
    tokens_by_type: { in_uncached: 100, cache_read: 0, cache_write: 0, out: 0 },
    usd_by_type: null,
    billed_usd: billed,
    share: 1,
    calls: 1,
    seat_time: billed == null ? null : { months: 0, weeks: 0 },
    equivalents: rankingEquivalents,
    cost_at_full_use_usd: null,
    provenance: rankingProvenance,
  };
}

function rankingSubject(partial: Partial<SubjectCost> & Pick<SubjectCost, "subject" | "id">): SubjectCost {
  return {
    kind: "project",
    tokens: 100,
    api_usd: 10,
    billed_usd: null,
    billed_complete: false,
    share_of_priced_spend_pct: null,
    priced_spend_usd: 5,
    calls: 1,
    by_sub: {},
    subscriptions: {},
    ...partial,
  };
}

function rankingCost(subjects: SubjectCost[]): ProjectCostResponse {
  return {
    ...cost,
    subscriptions: [
      {
        id: "codex1",
        vendor: "codex",
        plan: "pro",
        usd_per_month: 20,
        usd_per_month_declared: 20,
        plan_periods: [],
        api_usd: 10,
        attributed_usd: 10,
        first_day: "2026-08-10",
        last_day: "2026-08-10",
        days: 1,
        paid_usd: 5,
        basis: "rate-card",
      },
      {
        id: "grok",
        vendor: "grok",
        plan: "super",
        usd_per_month: null,
        usd_per_month_declared: null,
        plan_periods: [],
        api_usd: 10,
        attributed_usd: 10,
        first_day: "2026-08-10",
        last_day: "2026-08-10",
        days: 1,
        paid_usd: null,
        basis: "vendor",
      },
    ],
    subjects,
  };
}

describe("ProjectUsage guardrail repairs", () => {
  it("rejects pre-merge cost data until the matching post-mutation generation succeeds", () => {
    const retained = { data: { generation: 3, payload: cost }, error: null, loading: false };
    expect(costForRequest(retained, { generation: 4, since: "2026-08-01" })).toBeNull();
    expect(
      costForRequest({ ...retained, data: { generation: 4, payload: cost }, error: "reload failed" }, {
        generation: 4,
        since: "2026-08-01",
      }),
    ).toBeNull();
    expect(
      costForRequest({ ...retained, data: { generation: 4, payload: cost } }, {
        generation: 4,
        since: "2026-08-01",
      }),
    ).toBe(cost);
    expect(costForRequest(retained, { generation: 3, since: "2026-08-02" })).toBeNull();
  });

  it("keeps the matching cost on screen while the same request reloads", () => {
    const reloading = { data: { generation: 4, payload: cost }, error: null, loading: true };
    expect(costForRequest(reloading, { generation: 4, since: "2026-08-01" })).toBe(cost);
    expect(costForRequest(reloading, { generation: 5, since: "2026-08-01" })).toBeNull();
  });

  it("renders tile and ranking session time with approximation and echoed idle-gap provenance", () => {
    const tiles = renderToStaticMarkup(
      <ProjectTiles totalSeconds={3600} idleGap={30} days={30} cost={null} loading={false} error={null} />,
    );
    const ranking = renderToStaticMarkup(
      <table>
        <tbody>
          <SubjectRowView
            row={row}
            active={false}
            picked={false}
            maxApi={1}
            billed={null}
            apiUsd={null}
            mix={null}
            sharePct={null}
            idleGap={30}
            onClick={() => {}}
            onPick={() => {}}
          />
        </tbody>
      </table>,
    );

    expect(ranking).toContain("≈ 1h");
    expect(ranking).toContain("threshold 30m");
    expect(ranking).toContain("idle threshold");
    expect(tiles).toContain("Agent session time");
    expect(tiles).toContain("threshold 30 min");
    expect(tiles).toContain("idle threshold of 30 min");
  });

  it("labels summed session time with the average parallelism computed from the data", () => {
    // 2,690 session hours in 30 days are about 3.7 sessions at once, not 2,690 hours of work.
    expect(agentParallelism(2_690 * 3_600, 30)).toBeCloseTo(3.736, 3);
    expect(agentParallelism(3_600, null)).toBeNull();
    expect(agentParallelism(0, 30)).toBeNull();
    const tiles = renderToStaticMarkup(
      <ProjectTiles totalSeconds={2_690 * 3_600} idleGap={15} days={30} cost={null} loading={false} error={null} />,
    );
    expect(tiles).toContain("≈ 3.7 sessions in parallel over 30 days");
    expect(tiles).not.toContain("Total time");
  });

  it("sorts the ranking by API-eq by default, subjects without a value last", () => {
    const subjects = [
      { ...row, id: "tokens-heavy", tokens: 900 },
      { ...row, id: "priced", tokens: 10 },
      { ...row, id: "unpriced", tokens: 500 },
    ];
    const mapped = rankingCostOf(rankingCost([
      rankingSubject({ subject: "p:tokens-heavy", id: "tokens-heavy", api_usd: 5, billed_usd: 9, billed_complete: true }),
      rankingSubject({ subject: "p:priced", id: "priced", api_usd: 50, billed_usd: 1, billed_complete: true }),
    ]));
    expect(sortSubjects(subjects, "api", mapped).map((r) => r.id)).toEqual(["priced", "tokens-heavy", "unpriced"]);
    expect(sortSubjects(subjects, "share", mapped).map((r) => r.id)).toEqual(["tokens-heavy", "priced", "unpriced"]);
    expect(sortSubjects(subjects, "tokens", mapped).map((r) => r.id)).toEqual(["tokens-heavy", "unpriced", "priced"]);
    const src = fs.readFileSync(path.join(import.meta.dir, "ProjectUsage.tsx"), "utf8");
    expect(src).toContain('useState<SortKey>("api")');
  });

  it("wires the drawer retry to the cost reload path, not a no-op", () => {
    const src = fs.readFileSync(path.join(import.meta.dir, "ProjectUsage.tsx"), "utf8");
    expect(src).toContain("onCostRetry={costState.reload}");
    expect(src).not.toMatch(/onCostRetry=\{\(\)\s*=>\s*\{\s*\}\}/);
  });

  it("labels excluded conflict totals as accepted traffic and preserves the old title without the field", () => {
    const conflictingCost: ProjectCostResponse = {
      ...cost,
      totals: { ...cost.totals, tokens: 100, api_usd: 10 },
      coverage: {
        ...cost.coverage,
        conflicting_usage: {
          vendor: "claude",
          identities: 2,
          accounts: [{ account: "acct-a", identities: 2 }],
          tokens: null,
          api_usd: null,
          billed_usd: null,
          note: "synthetic conflict",
        },
      },
    };
    const tiles = renderToStaticMarkup(
      <ProjectTiles totalSeconds={3600} idleGap={15} days={30} cost={conflictingCost} loading={false} error={null} />,
    );
    const plainTiles = renderToStaticMarkup(
      <ProjectTiles totalSeconds={3600} idleGap={15} days={30} cost={cost} loading={false} error={null} />,
    );

    expect(tiles).toContain("Excluded conflicting Claude call identities: 2.");
    expect(tiles).toContain("Account fee allocation is unavailable for: acct-a.");
    expect(tiles).toContain("Accepted traffic subtotal in the period");
    expect(tiles).not.toContain("All recorded traffic in the period");
    expect(plainTiles).toContain("All recorded traffic in the period");
    expect(plainTiles).not.toContain("Accepted traffic subtotal in the period");
    expect(plainTiles).not.toContain("Excluded conflicting Claude call identities:");
  });
});

describe("ProjectUsage subject billed completeness", () => {
  const allNull = rankingSubject({
    subject: "p:all-null",
    id: "all-null",
    billed_usd: null,
    billed_complete: false,
    share_of_priced_spend_pct: null,
    subscriptions: { grok: rankingSlice(null, 163.23) },
  });
  const mixed = rankingSubject({
    subject: "p:mixed",
    id: "mixed",
    billed_usd: 5.5,
    billed_complete: false,
    share_of_priced_spend_pct: 40,
    subscriptions: { grok: rankingSlice(null, 163.23), codex1: rankingSlice(5.5, 10) },
  });
  const pricedZero = rankingSubject({
    subject: "p:zero",
    id: "zero",
    billed_usd: 0,
    billed_complete: true,
    share_of_priced_spend_pct: 0,
    subscriptions: { codex1: rankingSlice(0, 10) },
  });

  it("maps all-null, mixed and priced-zero subjects without coercing absence to 0", () => {
    const mapped = rankingCostOf(rankingCost([allNull, mixed, pricedZero]));

    expect(mapped.billed.get("p:all-null")).toBeNull();
    expect(mapped.billedComplete.get("p:all-null")).toBe(false);
    expect(mapped.share.get("p:all-null")).toBeNull();
    expect(mapped.mix.get("p:all-null")?.map((s) => [s.id, s.billed])).toEqual([["grok", null]]);

    expect(mapped.billed.get("p:mixed")).toBe(5.5);
    expect(mapped.billedComplete.get("p:mixed")).toBe(false);
    expect(mapped.share.get("p:mixed")).toBe(40);
    expect(mapped.mix.get("p:mixed")?.map((s) => [s.id, s.billed])).toEqual([
      ["codex1", 5.5],
      ["grok", null],
    ]);

    expect(mapped.billed.get("p:zero")).toBe(0);
    expect(mapped.billedComplete.get("p:zero")).toBe(true);
    expect(mapped.share.get("p:zero")).toBe(0);
    expect(mapped.mix.get("p:zero")?.map((s) => [s.id, s.billed])).toEqual([["codex1", 0]]);
  });

  it("renders unavailable, incomplete known subtotal, and measured zero distinctly", () => {
    const mapped = rankingCostOf(rankingCost([allNull, mixed, pricedZero]));

    const allNullHtml = renderToStaticMarkup(
      <table>
        <tbody>
          <SubjectRowView
            row={{ ...row, id: "all-null", name: "All null" }}
            active={false}
            picked={false}
            maxApi={163.23}
            billed={mapped.billed.get("p:all-null") ?? null}
            billedComplete={mapped.billedComplete.get("p:all-null")}
            apiUsd={mapped.api.get("p:all-null") ?? null}
            mix={mapped.mix.get("p:all-null") ?? null}
            sharePct={mapped.share.get("p:all-null") ?? null}
            idleGap={15}
            onClick={() => {}}
            onPick={() => {}}
          />
        </tbody>
      </table>,
    );
    expect(allNullHtml).toContain("data-billed-unavailable");
    expect(allNullHtml).toContain("—");
    expect(allNullHtml).toContain("grok");
    expect(allNullHtml).not.toContain("$0.00");
    expect(allNullHtml).not.toContain("data-billed-incomplete");

    const mixedHtml = renderToStaticMarkup(
      <table>
        <tbody>
          <SubjectRowView
            row={{ ...row, id: "mixed", name: "Mixed" }}
            active={false}
            picked={false}
            maxApi={163.23}
            billed={mapped.billed.get("p:mixed") ?? null}
            billedComplete={mapped.billedComplete.get("p:mixed")}
            apiUsd={mapped.api.get("p:mixed") ?? null}
            mix={mapped.mix.get("p:mixed") ?? null}
            sharePct={mapped.share.get("p:mixed") ?? null}
            idleGap={15}
            onClick={() => {}}
            onPick={() => {}}
          />
        </tbody>
      </table>,
    );
    expect(mixedHtml).toContain("$5.50");
    expect(mixedHtml).toContain("data-billed-incomplete");
    expect(mixedHtml).toContain("incomplete");
    expect(mixedHtml).toContain("grok");
    expect(mixedHtml).toContain("codex1");
    expect(mixedHtml).not.toContain("data-billed-unavailable");

    const zeroHtml = renderToStaticMarkup(
      <table>
        <tbody>
          <SubjectRowView
            row={{ ...row, id: "zero", name: "Zero" }}
            active={false}
            picked={false}
            maxApi={163.23}
            billed={mapped.billed.get("p:zero") ?? null}
            billedComplete={mapped.billedComplete.get("p:zero")}
            apiUsd={mapped.api.get("p:zero") ?? null}
            mix={mapped.mix.get("p:zero") ?? null}
            sharePct={mapped.share.get("p:zero") ?? null}
            idleGap={15}
            onClick={() => {}}
            onPick={() => {}}
          />
        </tbody>
      </table>,
    );
    expect(zeroHtml).toContain("$0.00");
    expect(zeroHtml).not.toContain("data-billed-incomplete");
    expect(zeroHtml).not.toContain("data-billed-unavailable");
    expect(zeroHtml).not.toContain("incomplete");
  });
});

const BEFORE_MIDNIGHT = Date.parse("2026-08-27T23:59:59.000Z");
const RANGE_30_MS = 30 * 86_400_000;

function sinceAt(nowMs: number): string {
  return new Date(nowMs - RANGE_30_MS).toISOString().slice(0, 10);
}

function sinceArgs(spy: { mock: { calls: ReadonlyArray<unknown[]> } }): Array<string | undefined> {
  return spy.mock.calls.map((c) => {
    const arg = c[0];
    if (!arg || typeof arg !== "object" || !("since" in arg)) return undefined;
    const since = (arg as { since?: unknown }).since;
    return typeof since === "string" ? since : undefined;
  });
}

describe("ProjectUsage UTC date boundary", () => {
  let host: TestNode;
  let root: Root | null = null;
  let subjects: ReturnType<typeof spyOn>;
  let projectCost: ReturnType<typeof spyOn>;

  afterEach(() => {
    try {
      act(() => root?.unmount());
    } finally {
      root = null;
      subjects?.mockRestore();
      projectCost?.mockRestore();
      jest.useRealTimers();
      restoreDom();
    }
  });

  it("refetches at UTC midnight with range untouched and does not refetch on same-date rerender", async () => {
    host = installTestDom();
    jest.useFakeTimers({ now: BEFORE_MIDNIGHT });
    subjects = spyOn(api, "subjects").mockImplementation(async (p) => ({
      idle_gap_minutes: p?.idle_gap ?? 15,
      since: p?.since ?? null,
      until: null,
      subjects: [row],
    }));
    projectCost = spyOn(api, "projectCost").mockImplementation(async (p) => ({
      ...cost,
      since: p?.since ?? null,
    }));

    root = createRoot(host as unknown as Element);
    await act(async () => {
      root!.render(<ProjectUsage />);
    });
    await flushUntil(() => textOf(host).includes("Alpha"));

    const beforeSince = sinceAt(BEFORE_MIDNIGHT);
    expect(sinceArgs(subjects)).toEqual([beforeSince]);
    expect(sinceArgs(projectCost)).toEqual([beforeSince]);
    expect(textOf(host)).toContain("Alpha");
    expect(textOf(host)).not.toContain("Wczytuję projekty");

    await act(async () => {
      root!.render(<ProjectUsage />);
    });
    await flushUntil(() => textOf(host).includes("Alpha"));
    expect(subjects.mock.calls.length).toBe(1);
    expect(projectCost.mock.calls.length).toBe(1);

    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    await flushUntil(() => textOf(host).includes("Alpha"));
    expect(subjects.mock.calls.length).toBe(1);

    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    await flushUntil(() => textOf(host).includes("Alpha") && subjects.mock.calls.length >= 2);

    const afterSince = sinceAt(BEFORE_MIDNIGHT + 2_000);
    expect(afterSince).not.toBe(beforeSince);
    expect(sinceArgs(subjects)).toEqual([beforeSince, afterSince]);
    expect(sinceArgs(projectCost)).toEqual([beforeSince, afterSince]);
    expect(textOf(host)).toContain("Alpha");
    expect(textOf(host)).not.toContain("Wczytuję projekty");
  });
});

type TestNode = {
  nodeType: number;
  nodeName: string;
  tagName: string;
  children: TestNode[];
  childNodes: TestNode[];
  style: Record<string, string> & { setProperty: (k: string, v: string) => void };
  attributes: Record<string, string>;
  ownerDocument: TestDocument | null;
  parentNode: TestNode | null;
  namespaceURI: string;
  className: string;
  id: string;
  _text: string;
  value: string;
  selected: boolean;
  disabled: boolean;
  __handlers: Record<string, Array<(...args: unknown[]) => void>>;
  options?: TestNode[];
  appendChild: (c: TestNode) => TestNode;
  removeChild: (c: TestNode) => TestNode;
  insertBefore: (c: TestNode, ref: TestNode | null) => TestNode;
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  removeAttribute: (k: string) => void;
  hasAttribute: (k: string) => boolean;
  addEventListener: (t: string, fn: (...args: unknown[]) => void) => void;
  removeEventListener: () => void;
  dispatchEvent: () => boolean;
  contains: (n: TestNode) => boolean;
  cloneNode: () => TestNode;
  focus: () => void;
  blur: () => void;
  textContent: string;
};

type TestDocument = {
  nodeType: number;
  HTMLIFrameElement: { new (): object };
  HTMLElement: { new (): object };
  Element: { new (): object };
  Node: { new (): object };
  createElement: (t: string) => TestNode;
  createElementNS: (ns: string, t: string) => TestNode;
  createTextNode: (t: string) => TestNode;
  createComment: () => TestNode;
  createDocumentFragment: () => TestNode;
  getElementById: () => null;
  querySelector: () => null;
  querySelectorAll: () => [];
  addEventListener: (t: string, fn: (...args: unknown[]) => void) => void;
  removeEventListener: () => void;
  activeElement: TestNode | null;
  readyState: string;
  location: { href: string; origin: string; protocol: string };
  body: TestNode;
  documentElement: TestNode;
  head: TestNode;
  defaultView: typeof globalThis;
};

function installTestDom(): TestNode {
  restoreDom = preserveBrowserGlobals();
  function MiniNode(this: TestNode, tag: string) {
    this.nodeType = tag === "#text" ? 3 : 1;
    this.nodeName = String(tag).toUpperCase();
    this.tagName = this.nodeName;
    this.children = [];
    this.childNodes = this.children;
    const style = { setProperty(k: string, v: string) { style[k] = v; } } as TestNode["style"];
    this.style = style;
    this.attributes = {};
    this.ownerDocument = null;
    this.parentNode = null;
    this.namespaceURI = "http://www.w3.org/1999/xhtml";
    this.className = "";
    this.id = "";
    this._text = "";
    this.value = "";
    this.selected = false;
    this.disabled = false;
    this.__handlers = {};
  }
  MiniNode.prototype.appendChild = function (this: TestNode, c: TestNode) {
    this.children.push(c);
    c.parentNode = this;
    return c;
  };
  MiniNode.prototype.removeChild = function (this: TestNode, c: TestNode) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null;
    return c;
  };
  MiniNode.prototype.insertBefore = function (this: TestNode, c: TestNode, ref: TestNode | null) {
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i >= 0) this.children.splice(i, 0, c);
    else this.children.push(c);
    c.parentNode = this;
    return c;
  };
  MiniNode.prototype.setAttribute = function (this: TestNode, k: string, v: string) {
    this.attributes[k] = v;
    if (k === "class") this.className = v;
    if (k === "id") this.id = v;
  };
  MiniNode.prototype.getAttribute = function (this: TestNode, k: string) {
    return this.attributes[k] ?? null;
  };
  MiniNode.prototype.removeAttribute = function (this: TestNode, k: string) {
    delete this.attributes[k];
  };
  MiniNode.prototype.hasAttribute = function (this: TestNode, k: string) {
    return k in this.attributes;
  };
  MiniNode.prototype.addEventListener = function (this: TestNode, t: string, fn: (...args: unknown[]) => void) {
    (this.__handlers[t] ||= []).push(fn);
  };
  MiniNode.prototype.removeEventListener = function () {};
  MiniNode.prototype.dispatchEvent = function () {
    return true;
  };
  MiniNode.prototype.contains = function (this: TestNode, n: TestNode) {
    if (n === this) return true;
    return this.children.some((c) => c.contains(n));
  };
  MiniNode.prototype.cloneNode = function (this: TestNode) {
    return new (MiniNode as unknown as { new (t: string): TestNode })(this.tagName);
  };
  MiniNode.prototype.focus = function () {};
  MiniNode.prototype.blur = function () {};
  Object.defineProperty(MiniNode.prototype, "textContent", {
    get(this: TestNode) {
      if (this.nodeType === 3) return this._text;
      const childText = this.children.map((c) => c.textContent).join("");
      return childText || this._text || "";
    },
    set(this: TestNode, v: string) {
      this._text = String(v);
      this.children.length = 0;
    },
  });
  Object.defineProperty(MiniNode.prototype, "innerHTML", {
    get(this: TestNode) {
      return this.textContent;
    },
    set(this: TestNode, v: string) {
      this._text = String(v);
    },
  });
  Object.defineProperty(MiniNode.prototype, "firstChild", {
    get(this: TestNode) {
      return this.children[0] ?? null;
    },
  });
  Object.defineProperty(MiniNode.prototype, "lastChild", {
    get(this: TestNode) {
      return this.children[this.children.length - 1] ?? null;
    },
  });
  Object.defineProperty(MiniNode.prototype, "parentElement", {
    get(this: TestNode) {
      return this.parentNode;
    },
  });
  Object.defineProperty(MiniNode.prototype, "nextSibling", {
    get(this: TestNode) {
      const p = this.parentNode;
      if (!p) return null;
      const i = p.children.indexOf(this);
      return p.children[i + 1] ?? null;
    },
  });
  Object.defineProperty(MiniNode.prototype, "previousSibling", {
    get(this: TestNode) {
      const p = this.parentNode;
      if (!p) return null;
      const i = p.children.indexOf(this);
      return p.children[i - 1] ?? null;
    },
  });
  Object.defineProperty(MiniNode.prototype, "nodeValue", {
    get(this: TestNode) {
      return this._text || null;
    },
    set(this: TestNode, v: string) {
      this._text = v;
    },
  });
  Object.defineProperty(MiniNode.prototype, "options", {
    get(this: TestNode) {
      if (this.tagName !== "SELECT") return undefined;
      const out: TestNode[] = [];
      const walk = (nodes: TestNode[]) => {
        for (const n of nodes) {
          if (n.tagName === "OPTION") out.push(n);
          else walk(n.children);
        }
      };
      walk(this.children);
      return out;
    },
  });

  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const addEventListener = (t: string, fn: (...args: unknown[]) => void) => {
    (listeners[t] ||= []).push(fn);
  };
  const removeEventListener = () => {};

  function HTMLIFrameElement() {}
  function HTMLElement() {}
  function Element() {}
  function Node() {}

  const doc = {
    nodeType: 9,
    HTMLIFrameElement,
    HTMLElement,
    Element,
    Node,
    createElement(t: string) {
      const n = new (MiniNode as unknown as { new (t: string): TestNode })(t);
      n.ownerDocument = doc as unknown as TestDocument;
      return n;
    },
    createElementNS(ns: string, t: string) {
      const n = new (MiniNode as unknown as { new (t: string): TestNode })(t);
      n.ownerDocument = doc as unknown as TestDocument;
      n.namespaceURI = ns;
      return n;
    },
    createTextNode(t: string) {
      const n = new (MiniNode as unknown as { new (t: string): TestNode })("#text");
      n.nodeType = 3;
      n.nodeName = "#text";
      n._text = String(t);
      n.ownerDocument = doc as unknown as TestDocument;
      return n;
    },
    createComment() {
      const n = new (MiniNode as unknown as { new (t: string): TestNode })("#comment");
      n.nodeType = 8;
      n.ownerDocument = doc as unknown as TestDocument;
      return n;
    },
    createDocumentFragment() {
      const n = new (MiniNode as unknown as { new (t: string): TestNode })("#fragment");
      n.nodeType = 11;
      n.ownerDocument = doc as unknown as TestDocument;
      return n;
    },
    getElementById() {
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener,
    removeEventListener,
    activeElement: null as TestNode | null,
    readyState: "complete",
    location: { href: "http://localhost/", origin: "http://localhost", protocol: "http:" },
    body: null as unknown as TestNode,
    documentElement: null as unknown as TestNode,
    head: null as unknown as TestNode,
    defaultView: globalThis,
  };
  doc.body = doc.createElement("body");
  doc.documentElement = doc.createElement("html");
  doc.head = doc.createElement("head");

  globalThis.document = doc as unknown as Document;
  globalThis.addEventListener = addEventListener as typeof globalThis.addEventListener;
  globalThis.removeEventListener = removeEventListener as typeof globalThis.removeEventListener;
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
  Object.defineProperty(globalThis, "self", { configurable: true, value: globalThis });
  Object.defineProperty(globalThis, "innerWidth", { configurable: true, value: 1920 });
  Object.defineProperty(globalThis, "innerHeight", { configurable: true, value: 1080 });
  globalThis.navigator = { userAgent: "bun-test" } as Navigator;
  globalThis.HTMLIFrameElement = HTMLIFrameElement as unknown as typeof globalThis.HTMLIFrameElement;
  globalThis.HTMLElement = HTMLElement as unknown as typeof globalThis.HTMLElement;
  globalThis.Element = Element as unknown as typeof globalThis.Element;
  globalThis.Node = Node as unknown as typeof globalThis.Node;
  globalThis.SVGElement = function SVGElement() {} as unknown as typeof globalThis.SVGElement;
  globalThis.Event = function Event(this: { type: string }, type: string) {
    this.type = type;
  } as unknown as typeof Event;
  globalThis.getComputedStyle = () => new Proxy({}, { get: () => "" }) as CSSStyleDeclaration;
  if (typeof globalThis.requestAnimationFrame !== "function") {
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) =>
      setTimeout(() => cb(Date.now()), 16) as unknown as number;
    globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  doc.defaultView = globalThis;

  const host = doc.createElement("div");
  doc.body.appendChild(host);
  return host;
}

function textOf(node: TestNode): string {
  return node.textContent;
}

async function flushUntil(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (pred()) return;
    await act(async () => {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    });
  }
  throw new Error("timed out waiting for ProjectUsage to settle");
}
