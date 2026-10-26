import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { RepoBucketPoint } from "../../lib/api";
import { setLanguage } from "../../lib/i18n";
import { installTestDom, invoke, type TestNode } from "../../lib/test-dom-harness";
import { ProjectMixChart } from "./ProjectMixChart";

const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];
const points: RepoBucketPoint[] = [
  {
    bucket: "2026-08-03", tokens: 1000, calls: 2,
    active_seconds: 3600, active_by_machine: {}, session_seconds: 7200, 
    api_usd: 60, api_complete: true, billed_usd: 5, billed_complete: true,
    by_sub: { codex1: { api_usd: 60, billed_usd: 5 } },
  },
  {
    bucket: "2026-08-10", tokens: 2000, calls: 3,
    active_seconds: 1800, active_by_machine: {}, session_seconds: 3600, 
    api_usd: 40, api_complete: true, billed_usd: 3, billed_complete: true,
    by_sub: { codex1: { api_usd: 40, billed_usd: 3 } },
  },
];
const props = {
  title: "usage", points, totalsBySub: { codex1: { api_usd: 100, billed_usd: 8 } },
  granularity: "week" as const, colorOf: () => "var(--codex)", nameOf: () => "account one",
  idleGap: 15, fileName: "mix.png",
  units: [{ id: "codex1", label: "account one", color: "var(--codex)", windowValue: 100,
    windowHours: 168, usdPerMonth: 200, basis: "measured" as const, note: "measured capacity" }],
  vendorBySub: { codex1: "codex" },
  vendorCoverage: [{ vendor: "codex", first: "2026-01-01", last: "2026-12-31" }],
};

test("unit switching, hover, hiding values and language changes share the mounted chart's state", async () => {
  setLanguage("en");
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const chart = () => dom.host.children[0]!;
  const summary = () => chart().children[1]!.textContent;
  const button = (label: string) => nodes(dom.host).find(node => node.tagName === "BUTTON" && node.textContent === label)!;
  try {
    await act(async () => root.render(<ProjectMixChart {...props} />));
    const dollarBuckets = nodes(dom.host).filter(node => node.tagName === "G" && node.children.some(child => child.tagName === "TITLE"));
    await invoke(dollarBuckets[0]!, "onMouseEnter");
    expect(summary()).toContain("2026-08-03");
    expect(summary()).toContain("$5.00");
    expect(summary()).toContain("1h 00m");
    expect(summary()).not.toContain("2h 00m");

    await invoke(button("% of window limit"), "onClick");
    expect(nodes(dom.host).filter(node => node.getAttribute("data-pct-bucket") != null)).toHaveLength(2);
    expect(summary()).toContain("2026-08-03");
    const second = nodes(dom.host).find(node => node.getAttribute("data-pct-bucket") === "2026-08-10")!;
    await invoke(second, "onMouseEnter");
    expect(summary()).toContain("2026-08-10");
    expect(summary()).toContain("30m");

    await act(async () => root.render(<ProjectMixChart {...props} hideValues initialUnit="usd" />));
    expect(button("% of window limit").getAttribute("aria-pressed")).toBe("true");
    expect(summary()).toContain("values hidden");
    expect(summary()).not.toContain("$3.00");
    expect(summary()).not.toContain("30m");

    await act(async () => setLanguage("pl"));
    expect(button("% limitu okna").getAttribute("aria-pressed")).toBe("true");
    expect(summary()).toContain("liczby ukryte");
    await act(async () => root.render(<ProjectMixChart {...props} />));
    expect(summary()).toContain("Czas");
    expect(summary()).toContain("2026-08-10");
    await invoke(nodes(dom.host).find(node => node.tagName === "SVG")!, "onMouseLeave");
    expect(summary()).toBe("");
  } finally {
    await act(async () => root.unmount());
    dom.restore();
    setLanguage("en");
  }
});

test("an empty or replaced series keeps the selected unit and resolves hover against current points", async () => {
  setLanguage("en");
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  try {
    await act(async () => root.render(<ProjectMixChart {...props} initialUnit="pct" />));
    const second = nodes(dom.host).find(node => node.getAttribute("data-pct-bucket") === "2026-08-10")!;
    await invoke(second, "onMouseEnter");
    await act(async () => root.render(<ProjectMixChart {...props} points={[]} />));
    expect(dom.host.textContent).toContain("No data in this range");
    await act(async () => root.render(<ProjectMixChart {...props} points={[points[0]!]} />));
    expect(nodes(dom.host).find(node => node.textContent === "% of window limit" && node.tagName === "BUTTON")!.getAttribute("aria-pressed")).toBe("true");
    expect(dom.host.children[0]!.children[1]!.textContent).toBe("");
    expect(nodes(dom.host).filter(node => node.getAttribute("data-pct-bucket") != null)).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    dom.restore();
  }
});
