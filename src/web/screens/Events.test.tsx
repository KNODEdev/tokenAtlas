import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api, type ApiAccount, type EventsResponse, type ProjectsResponse, type UsageEvent } from "../lib/api";
import { emptyModel } from "../lib/cycle";
import type { EventsTarget } from "../lib/events-filter";
import { setLanguage } from "../lib/i18n";
import type { ScreenId, ScreenProps } from "../lib/screens";
import type { RailWindow } from "../lib/windows";
import { flushUntil, installTestDom, invoke, type TestNode } from "../lib/test-dom-harness";
import { Events } from "./Events";
import { WindowHistory } from "./WindowHistory";
import { setContextPreview } from "../lib/context-premium";
import type { ConversationCourse } from "../../shared/conversation-course";

const accounts: ApiAccount[] = [{ id: "codex1", vendor: "codex", plan: null, login: null, machine: null, note: null, homes: [], ratelimit_rows: 0,
  event_rows: 1, windows: [], limit_ids: [], first_event_ts: null, last_event_ts: null, has_gauge: true, has_events: true }];

function props(patch: Partial<ScreenProps>): ScreenProps {
  return {
    model: emptyModel("codex1", 10080), unit: "percent", setUnit: () => {}, account: "codex1", selectAccount: () => {}, accounts, capabilities: null,
    card: null, project: "", setProject: () => {}, projects: [], chosen: null, selectCycle: () => {}, openDrawer: () => {}, windowRailInShell: false,
    goto: () => {}, compare: [], setCompare: () => {}, sync: null, triggerSync: () => {}, ...patch,
  };
}
const event = (patch: Partial<UsageEvent>): UsageEvent => ({ ts: "2026-09-18T10:00:00.000Z", vendor: "codex", account: "codex1", model: "gpt-6-sol",
  surface: "ide-app", project: "alpha", tokens: 1_000, tokens_fresh: 100, in_uncached: 50, in_cached: 900, cache_write: 0, out: 50, reasoning: 10, usd: 0.25, ...patch });
const page = (rows: UsageEvent[]): EventsResponse => ({ vendor: "codex", account: "codex1", order: "ts_desc", since: null, until: null, limit: 50,
  offset: 0, returned: rows.length, has_more: false, rows, unpriced: { tokens: 0, models: {} } });
const text = (node: TestNode) => node.textContent;
function all(node: TestNode): TestNode[] { return [node, ...node.children.flatMap(all)]; }

describe("Usage events navigation", () => {
  let root: Root | null = null;
  const restore: Array<() => void> = [];
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    setContextPreview(false);
    while (restore.length) restore.pop()!();
  });

  it("opens the entire conversation on demand and restores stored values without an OFF request", async () => {
    setLanguage("en");
    const dom = installTestDom(); restore.push(dom.restore);
    const data: ConversationCourse = { vendor: "codex", identity: "chat", basis: "conversation", unit: "call", excluded: 0,
      truncated: false, approximate_order: false, calls: Array.from({ length: 10 }, (_, i) => ({ key: String(i), ts: "2026-09-18T10:00:00Z",
        model: "gpt-6-sol", tokens: { input: 100, cache_read: 200, cache_write: 0, output: 10 }, api_usd: 0.001, price_partial: false })) };
    const events = spyOn(api, "events").mockResolvedValue(page([event({ conversation: { vendor: "codex", reference_id: 42 } })]));
    const breakdown = spyOn(api, "breakdown").mockResolvedValue({ rows: [] });
    const projects = spyOn(api, "projects").mockResolvedValue({ projects: [], unassigned: { vendors: {} }, file: "projects.json" } as unknown as ProjectsResponse);
    const course = spyOn(api, "conversationCourse").mockImplementation(async params => params.context
      ? { ...data, calls: data.calls.map(call => ({ ...call, context_price: { base: 0.001, stored: 0.001, extra: 0.002, included: false } })) } : data);
    restore.push(() => { events.mockRestore(); breakdown.mockRestore(); projects.mockRestore(); course.mockRestore(); });
    root = createRoot(dom.host as unknown as Element);
    await act(async () => root!.render(<Events {...props({})} />));
    await flushUntil(() => text(dom.host).includes("gpt-6-sol"));
    expect(course).not.toHaveBeenCalled();
    await invoke(all(dom.host).find(node => node.tagName === "TR" && node.className.includes("events-row"))!, "onClick");
    const trigger = all(dom.host).find(node => node.tagName === "BUTTON" && text(node) === "Conversation →")!;
    await invoke(trigger, "onClick", { currentTarget: trigger });
    await flushUntil(() => text(dom.host).includes("Input · start → end"));
    expect(course.mock.calls[0]?.[0]).toEqual({ vendor: "codex", reference_id: 42 });
    expect(text(dom.host)).toContain("$0.001");
    await act(async () => setContextPreview(true));
    await flushUntil(() => text(dom.host).includes("$0.003"));
    expect(course).toHaveBeenCalledTimes(2);
    await act(async () => setContextPreview(false));
    expect(text(dom.host)).toContain("$0.001");
    expect(course).toHaveBeenCalledTimes(2);
    const charts = all(dom.host).filter(node => node.tagName.toLowerCase() === "svg" && node.attributes.role === "group");
    expect(charts.map(node => node.attributes["aria-label"])).toEqual(["Input size · tokens", "Cache read · % of input", "API value"]);
    expect(text(charts[1]!)).toContain("100.0%");
    expect(text(charts[1]!)).toContain("66.7%");
    const point = all(charts[1]!).find(node => node.attributes["aria-label"]?.startsWith("Call 1 ·"))!;
    expect(point.attributes["aria-label"]).toContain("output: 10");
    await invoke(point, "onFocus");
    expect(all(dom.host).filter(node => node.tagName === "SPAN" && node.className === "ui-figure" && text(node).startsWith("Call 1 ·"))).toHaveLength(3);
    await invoke(all(dom.host).find(node => node.tagName === "BUTTON" && node.attributes["aria-label"] === "Close conversation")!, "onClick");
    expect(all(dom.host).some(node => node.tagName === "DIALOG")).toBe(false);
  });

  it("sends the target's account, window dates and model to /api/events and leads back to where it came from", async () => {
    setLanguage("en");
    const dom = installTestDom(); restore.push(dom.restore);
    const events = spyOn(api, "events").mockResolvedValue(page([event({}), event({ vendor: "grok", account: null, model: "grok-4.6-build", surface: "turn (98 wywołań)" })]));
    const breakdown = spyOn(api, "breakdown").mockResolvedValue({ rows: [] });
    const projects = spyOn(api, "projects").mockResolvedValue({ projects: [], unassigned: { vendors: {} }, file: "projects.json" } as unknown as ProjectsResponse);
    restore.push(() => { events.mockRestore(); breakdown.mockRestore(); projects.mockRestore(); });
    const visited: ScreenId[] = [];
    const target: EventsTarget = { account: "codex1", since: "2026-09-12", until: "2026-09-18", origin: "History › codex1 › #69", returnScreen: "history" };
    root = createRoot(dom.host as unknown as Element);
    await act(async () => root!.render(<Events {...props({ eventsTarget: target, goto: screen => visited.push(screen) })} />));
    await flushUntil(() => text(dom.host).includes("gpt-6-sol"));
    expect(events.mock.calls[0]?.[0]).toMatchObject({ account: "codex1", since: "2026-09-12", until: "2026-09-18", limit: 50, offset: 0 });
    expect(events.mock.calls[0]?.[0]).not.toHaveProperty("vendor");
    expect(text(dom.host)).toContain("Came from: History › codex1 › #69");
    // Grok rows are aggregated turns, and a page is never summed as if it were the filter.
    expect(text(dom.host)).toContain("turn · 98 calls");
    expect(text(dom.host)).toContain("totals for the whole filter are not available");
    expect(text(dom.host)).not.toContain("on this page");
    await invoke(all(dom.host).find(node => node.tagName === "BUTTON" && text(node) === "← back")!, "onClick");
    expect(visited).toEqual(["history"]);
  });

  it("History's window panel opens Usage events for the selected window", async () => {
    setLanguage("en");
    const dom = installTestDom(); restore.push(dom.restore);
    const window = { key: "w1", counterKey: "claude:weekly_all:all", counterLabel: "7d", label: "7d", dateLabel: "01.09 – 08.09", source: "probe",
      isCurrent: false, usedPercent: 80, percentBasis: "measured", elapsedPercent: 100, ppAhead: null, windowHours: 168,
      startIso: "2026-09-01T09:00:00.000Z", resetIso: "2026-09-08T09:00:00.000Z", shape: [{ t: 0, pct: 0 }, { t: 100, pct: 80 }],
      regimeKey: "claude:weekly_all:all:max:168h", sampledAtIso: null, sampleMachine: null, tokensTotal: 1_000, usd: 2, note: null, scope: null, sublimits: [] } as unknown as RailWindow;
    const opened: EventsTarget[] = [];
    root = createRoot(dom.host as unknown as Element);
    await act(async () => root!.render(<WindowHistory windows={[window]} account="claude-max" activeKey="w1" onSelect={() => {}} onEvents={target => opened.push(target)} />));
    await invoke(all(dom.host).find(node => node.tagName === "BUTTON" && text(node).startsWith("Events for the window"))!, "onClick");
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ account: "claude-max", since: "2026-09-01", until: "2026-09-08", returnScreen: "history" });
  });
});
