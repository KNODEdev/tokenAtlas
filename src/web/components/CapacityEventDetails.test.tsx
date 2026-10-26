import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { CodexComparisonWindow, TimelineMarker } from "../../shared/codex-accounting";
import { setLanguage } from "../lib/i18n";
import { installTestDom, invoke, type TestNode } from "../lib/test-dom-harness";
import { capacityMarkers, CapacityMilestones, isPolicyMarker } from "./CapacityAnnotations";
import { CapacityCycleList } from "./CapacityCycleList";
import { CapacityHistoryChart } from "./CapacityHistoryChart";

const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];
const cycle: CodexComparisonWindow = {
  id: "event-test", account: "codex1", plan: "pro", plan_detail: { label: "Pro · ×20", multiplier: 20, status: "resolved" },
  start: "2026-09-29T00:00:00Z", end: "2026-09-30T00:00:00Z", reset: "2026-09-30T00:00:00Z",
  start_percent: 0, end_percent: 70, observed_pp: 70, probes: 10, max_gap_hours: 1,
  usage: { events: 100, unpriced_events: 0, tokens: 100, input: 90, cached: 80, output: 10, fast_tokens: 0,
    unknown_tokens: 50, priced_tokens: 100, api_standard: 1400, credits_low: 35000, credits_high: 70000 }, sources: [], models: [],
};

for (const view of ["chart", "cycles", "milestones"] as const) test(`${view}: full event note opens on click, links sources and restores focus on Escape`, async () => {
  setLanguage("pl");
  const marker = capacityMarkers(null, "2026-09-29", "2026-09-29").find(isPolicyMarker)!;
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
  try {
    await act(async () => root.render(view === "chart" ? <CapacityHistoryChart windows={[cycle]} markers={[marker]} unit="api_standard"
      basis="observed" median={{ value: null, plan: null, count: 0, reason: "too_few" }} since="2026-09-29" until="2026-09-30" title="Pojemność" subtitle="" />
      : view === "cycles" ? <CapacityCycleList windows={[cycle]} markers={[marker]} basis="observed" creditsAvailable
        referenceScope="event-test" measuresKey="event-test" defaultMeasures={["api_standard"]} empty="" subtitle="" />
        : <CapacityMilestones markers={[marker]} />));
    expect(nodes(dom.host).some(n => n.tagName === "DIALOG")).toBe(false);
    const trigger = nodes(dom.host).find(n => n.getAttribute("aria-haspopup") === "dialog" &&
      (n.textContent.includes(marker.label) || n.getAttribute("aria-label") === marker.label))!;
    expect(trigger).toBeDefined();
    let focusRestored = false;
    trigger.focus = () => { focusRestored = true; };
    if (view === "chart") {
      await invoke(trigger, "onFocus");
      const tooltip = nodes(dom.host).find(n => n.getAttribute("role") === "tooltip")!;
      expect(tooltip.textContent).toContain("do 29 października 2026 włącznie");
      expect(tooltip.textContent).toContain("Kliknij, aby otworzyć pełny opis");
    } else expect(trigger.getAttribute("title") ?? trigger.parentNode?.getAttribute("title")).toContain("do 29 października 2026 włącznie");
    await invoke(trigger, "onClick", { currentTarget: trigger });
    const dialog = nodes(dom.host).find(n => n.tagName === "DIALOG")!;
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(dialog.textContent).toContain("06:41:17 UTC");
    expect(dialog.textContent).toContain("15:10:31 UTC");
    expect(dialog.textContent).toContain("do 29 października 2026 włącznie");
    expect(dialog.textContent).toContain("od 30 października");
    expect(nodes(dialog).filter(n => n.tagName === "P").length).toBeGreaterThanOrEqual(4);
    const links = nodes(dialog).filter(n => n.tagName === "A");
    const official = nodes(dialog).find(n => n.getAttribute("aria-label") === "Oficjalne źródła")!;
    expect(official).toBeDefined();
    expect(nodes(official).filter(n => n.tagName === "A").map(n => n.getAttribute("href"))).toEqual([
      "https://x.com/thsottiaux/status/2104823812042940713",
      "https://x.com/thsottiaux/status/2104951965184925941",
      "https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers",
    ]);
    expect(official.textContent).toContain("poprzedni limit do 29 października");
    expect(links.map(n => n.getAttribute("href"))).toContain("https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers");
    expect(links.every(n => n.getAttribute("target") === "_blank" && n.getAttribute("rel") === "noreferrer")).toBe(true);
    await invoke(dialog, "onCancel", { currentTarget: dialog, target: dialog, preventDefault() {} });
    expect(nodes(dom.host).some(n => n.tagName === "DIALOG")).toBe(false);
    expect(focusRestored).toBe(true);
  } finally { await act(async () => root.unmount()); dom.restore(); setLanguage("en"); }
});

test("chart keyboard opens grouped notes and renders custom text as text", async () => {
  setLanguage("en");
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
  const marker: TimelineMarker = { id: "custom:note", day: "2026-09-29", label: "Custom event", visible: true, color: "accent",
    note: "First paragraph.\n\n<script>alert(1)</script> javascript:alert(1)\n\nReference https://example.com/evidence." };
  try {
    await act(async () => root.render(<CapacityHistoryChart windows={[cycle]} markers={[marker, { ...marker, id: "custom:second", label: "Second event", note: "Second note" }]}
      unit="api_standard" basis="observed" median={{ value: null, plan: null, count: 0, reason: "too_few" }}
      since="2026-09-29" until="2026-09-30" title="Capacity" subtitle="" />));
    const trigger = nodes(dom.host).find(n => n.getAttribute("class") === "capacity-marker")!;
    for (const key of ["Enter", " "]) {
      let prevented = false;
      await invoke(trigger, "onKeyDown", { key, currentTarget: trigger, preventDefault() { prevented = true; } });
      expect(prevented).toBe(true);
      const dialog = nodes(dom.host).find(n => n.tagName === "DIALOG")!;
      expect(dialog.textContent).toContain("First paragraph.");
      expect(dialog.textContent).toContain("<script>alert(1)</script>");
      expect(dialog.textContent).toContain("Second note");
      expect(nodes(dialog).some(n => n.tagName === "SCRIPT")).toBe(false);
      expect(nodes(dialog).filter(n => n.tagName === "A").map(n => n.getAttribute("href"))).toEqual(["https://example.com/evidence"]);
      const close = nodes(dialog).find(n => n.getAttribute("aria-label") === "Close event details")!;
      await invoke(close, "onClick");
    }
  } finally { await act(async () => root.unmount()); dom.restore(); }
});
