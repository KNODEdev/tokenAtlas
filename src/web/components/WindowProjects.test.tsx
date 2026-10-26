import { expect, spyOn, test } from "bun:test";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { SelectedProjectChart, WindowProjects, WindowProjectsReport, barStep, drawnEnd, projectColors, projectWindowBuckets } from "./WindowProjects";
import { OverviewProjectSelector } from "./OverviewProjectSelector";
import { ALL_WINDOW_PROJECTS, projectTokenAllocation, windowProjectOptions, windowProjectsForScope } from "../lib/window-projects";
import { VendorOverview } from "./VendorOverview";
import { api } from "../lib/api";
import { chooseOption, dropdownOptions, dropdowns, installTestDom, invoke, type TestNode } from "../lib/test-dom-harness";
import { setLanguage } from "../lib/i18n";
import type { WindowProjectsResponse } from "../../shared/window-projects";

const zero = { calls: 2, tokens: 100, api_usd: 1, unpriced_calls: 0, invalid_calls: 0, approximate_calls: 0, unknown_mode_tokens: 0 };
export const projectWindowFixture: WindowProjectsResponse = {
  account: "account-a", provider: "codex", from: "2026-10-16T11:15:00.000Z", until: "2026-10-16T16:45:00.000Z",
  projects: [{ ...zero, project_id: "atlas", name: "tokenAtlas", models: [{ ...zero, model: "gpt-6.1-sol" }],
    hours: [{ hour: "2026-10-16T11:00:00.000Z", tokens: 40, calls: 1 }, { hour: "2026-10-16T16:00:00.000Z", tokens: 60, calls: 1 }] },
  { ...zero, tokens: 50, api_usd: null, unpriced_calls: 2, project_id: null, name: null, models: [{ ...zero, tokens: 50, api_usd: null, unpriced_calls: 2, model: null }],
    hours: [{ hour: "2026-10-16T12:00:00.000Z", tokens: 50, calls: 2 }] }],
};
const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];
test("chart buckets retain exact clipped edges, zeros and all project tokens", () => {
  const buckets = projectWindowBuckets(projectWindowFixture);
  expect(buckets[0]!.from).toBe(Date.parse(projectWindowFixture.from));
  expect(buckets.at(-1)!.until).toBe(Date.parse(projectWindowFixture.until));
  expect(buckets.map(bucket => bucket.values.reduce((sum, value) => sum + value, 0))).toEqual([40, 50, 0, 0, 0, 60]);
  expect(windowProjectsForScope(projectWindowFixture, "ACCOUNT-A", projectWindowFixture.from, projectWindowFixture.until)).toBe(projectWindowFixture);
  expect(windowProjectsForScope(projectWindowFixture, "other", projectWindowFixture.from, projectWindowFixture.until)).toBeNull();
});
test("the window picker lists active projects with token shares and allocation preserves the full account denominator", () => {
  const options = windowProjectOptions(projectWindowFixture, "Unassigned");
  expect(options.map(option => option.value)).toEqual(["atlas", "unassigned"]);
  expect(options[0]!.label).toContain("66.7%");
  const allocation = projectTokenAllocation(projectWindowFixture, "atlas", 80);
  expect(allocation.share).toBeCloseTo(2 / 3);
  expect(allocation.percent).toBeCloseTo(53.33333333);
  expect(projectTokenAllocation(projectWindowFixture, "unassigned", 80).percent).toBeCloseTo(26.66666667);
  expect(projectTokenAllocation(projectWindowFixture, "absent", 80).percent).toBeNull();
  expect(projectTokenAllocation(projectWindowFixture, "atlas", 100).factor).toBeNull();
  const invalid = structuredClone(projectWindowFixture); invalid.projects[1]!.invalid_calls = 1;
  expect(projectTokenAllocation(invalid, "atlas", 80).factor).toBeNull();
});
test("choosing an active project changes the main chart, estimated percentages use token shares, and a window switch clears an absent project", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  setLanguage("en");
  const requests: Array<{ account: string; signal?: AbortSignal; resolve: (data: WindowProjectsResponse) => void }> = [];
  const read = spyOn(api, "windowProjects").mockImplementation((params, signal) => new Promise(resolve => requests.push({ account: params.account, signal, resolve })));
  function Harness({ account }: { account: string }) {
    const [project, setProject] = useState("");
    return <><OverviewProjectSelector account={account} range={{ from: projectWindowFixture.from, until: projectWindowFixture.until }} value={project} onChange={setProject} />
      {project ? <SelectedProjectChart key={project} data={projectWindowFixture} project={project} usedPercent={80} /> : <span>Account chart</span>}</>;
  }
  try {
    await act(async () => root.render(<Harness account="account-a" />));
    expect((await dropdownOptions(dropdowns(dom.host)[0]!)).map(option => option.value)).toEqual(["", "__pending"]);
    await act(async () => requests[0]!.resolve(projectWindowFixture));
    const options = await dropdownOptions(dropdowns(dom.host)[0]!);
    expect(options.map(option => option.value)).toEqual(["", ALL_WINDOW_PROJECTS, "atlas", "unassigned"]);
    await chooseOption(dropdowns(dom.host)[0]!, ALL_WINDOW_PROJECTS);
    expect(nodes(dom.host).some(node => node.attributes["aria-label"] === "All projects usage")).toBe(true);
    await chooseOption(dropdowns(dom.host)[0]!, "atlas");
    expect(dom.host.textContent).not.toContain("Account chart");
    expect(dom.host.textContent).toContain("tokenAtlas");
    expect(dom.host.textContent).toContain("53.3%");
    const percentTab = nodes(dom.host).find(node => node.tagName === "BUTTON" && node.textContent === "≈ % of limit")!;
    await invoke(percentTab, "onClick");
    expect(nodes(dom.host).some(node => node.attributes["aria-label"]?.includes("estimated limit share"))).toBe(true);
    await act(async () => root.render(<Harness account="account-b" />));
    expect(requests[0]!.signal?.aborted).toBe(true);
    await act(async () => requests[1]!.resolve({ ...projectWindowFixture, account: "account-b", projects: [projectWindowFixture.projects[1]!] }));
    expect(dom.host.textContent).toContain("Account chart");
    expect((await dropdownOptions(dropdowns(dom.host)[0]!)).map(option => option.value)).toEqual(["", ALL_WINDOW_PROJECTS, "unassigned"]);
    await chooseOption(dropdowns(dom.host)[0]!, ALL_WINDOW_PROJECTS);
    await act(async () => root.render(<Harness account="account-c" />));
    await act(async () => requests[2]!.resolve({ ...projectWindowFixture, account: "account-c", projects: [] }));
    expect(dropdowns(dom.host)[0]!.textContent).toContain("All projects");
  } finally { await act(async () => root.unmount()); read.mockRestore(); dom.restore(); }
});

test("all projects share a stacked chart with reversible legend toggles and a fixed allocation denominator", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  setLanguage("en");
  const paths = () => nodes(dom.host).filter(node => node.tagName === "PATH");
  const legend = () => nodes(dom.host).find(node => node.attributes["aria-label"] === "Project legend")!;
  const button = (name: string) => legend().children.find(node => node.tagName === "BUTTON" && node.textContent.includes(name))!;
  try {
    await act(async () => root.render(<SelectedProjectChart data={projectWindowFixture} project={ALL_WINDOW_PROJECTS} usedPercent={80} />));
    expect(paths()).toHaveLength(2);
    expect(paths().every(path => path.attributes.d?.endsWith(" Z"))).toBe(true);
    const original = paths().map(path => ({ d: path.attributes.d, stroke: path.attributes.stroke }));
    expect(button("Unassigned").attributes["aria-pressed"]).toBe("true");
    await invoke(button("Unassigned"), "onClick");
    expect(paths()).toHaveLength(1);
    expect(button("Unassigned").attributes["aria-pressed"]).toBe("false");
    expect(paths()[0]!.attributes.stroke).toBe(original[0]!.stroke);
    const percentTab = nodes(dom.host).find(node => node.tagName === "BUTTON" && node.textContent === "≈ % of limit")!;
    await invoke(percentTab, "onClick");
    expect(button("tokenAtlas").textContent).toContain("53.3%");
    expect(button("Unassigned").textContent).toContain("26.7%");
    await invoke(button("tokenAtlas"), "onClick");
    expect(paths()).toHaveLength(0);
    expect(dom.host.textContent).toContain("No projects selected");
    await invoke(button("Unassigned"), "onClick");
    await invoke(button("tokenAtlas"), "onClick");
    const tokenTab = nodes(dom.host).find(node => node.tagName === "BUTTON" && node.textContent === "Tokens")!;
    await invoke(tokenTab, "onClick");
    expect(paths().map(path => ({ d: path.attributes.d, stroke: path.attributes.stroke }))).toEqual(original);
    await act(async () => root.render(<SelectedProjectChart key="next-scope" data={{ ...projectWindowFixture, account: "other" }} project={ALL_WINDOW_PROJECTS} usedPercent={80} />));
    expect(paths()).toHaveLength(2);
    expect(legend().children.filter(node => "aria-pressed" in node.attributes).every(node => node.attributes["aria-pressed"] === "true")).toBe(true);
  } finally { await act(async () => root.unmount()); dom.restore(); }
});
test("the legend's mini switch hides every project, then shows them all again", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  setLanguage("en");
  const paths = () => nodes(dom.host).filter(node => node.tagName === "PATH");
  const toggle = () => nodes(dom.host).find(node => node.tagName === "BUTTON" && (node.textContent === "hide all" || node.textContent === "show all"))!;
  try {
    await act(async () => root.render(<SelectedProjectChart data={projectWindowFixture} project={ALL_WINDOW_PROJECTS} usedPercent={80} />));
    expect(toggle().textContent).toBe("hide all");
    await invoke(toggle(), "onClick");
    expect(paths()).toHaveLength(0);
    expect(toggle().textContent).toBe("show all");
    await invoke(toggle(), "onClick");
    expect(paths()).toHaveLength(2);
    expect(toggle().textContent).toBe("hide all");
  } finally { await act(async () => root.unmount()); dom.restore(); }
});
test("hovering a table row highlights its project in every chart of the same window", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  setLanguage("en");
  const marks = () => nodes(dom.host).filter(node => node.tagName === "PATH" || node.tagName === "RECT");
  const opacityOf = (name: string) => marks().filter(node => node.textContent.startsWith(`${name} · `)).map(node => node.attributes.opacity);
  const row = (name: string) => nodes(dom.host).find(node => node.tagName === "TR" && node.textContent.includes(name) && !node.textContent.includes("Project"))!;
  try {
    await act(async () => root.render(<>
      <SelectedProjectChart data={projectWindowFixture} project={ALL_WINDOW_PROJECTS} usedPercent={80} />
      <WindowProjectsReport data={projectWindowFixture} />
    </>));
    expect(marks().every(node => node.attributes.opacity === "1")).toBe(true);
    await invoke(row("tokenAtlas"), "onMouseEnter");
    expect(opacityOf("tokenAtlas").length).toBeGreaterThan(2);
    expect(opacityOf("tokenAtlas").every(value => value === "1")).toBe(true);
    expect(opacityOf("Unassigned").length).toBeGreaterThan(1);
    expect(opacityOf("Unassigned").every(value => value === "0.2")).toBe(true);
    expect(row("tokenAtlas").style.background).toBe("var(--accent-soft)");
    await invoke(row("tokenAtlas"), "onMouseLeave");
    expect(marks().every(node => node.attributes.opacity === "1")).toBe(true);
  } finally { await act(async () => root.unmount()); dom.restore(); }
});
test("missing prices remain unknown and unknown modes stay lower bounds in headline and row", () => {
  setLanguage("en");
  const data = structuredClone(projectWindowFixture);
  data.projects[0]!.unknown_mode_tokens = 100;
  data.projects[0]!.models[0]!.unknown_mode_tokens = 100;
  const html = renderToStaticMarkup(<WindowProjectsReport data={data} />);
  expect(html).toContain("≥ $1.00");
  expect(html).toContain("Unknown mode tokens: 100");
  expect(html).toContain("Unassigned");
  expect(html).toContain("—");
  expect(html).not.toContain("% of limit");
});
test("Projects is lazy, opens its drawer, and cancels a pending read after a scope change", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage"), storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } });
  setLanguage("en");
  const pending: Array<{ account: string; signal?: AbortSignal; resolve: (data: WindowProjectsResponse) => void }> = [];
  const read = spyOn(api, "windowProjects").mockImplementation((params, signal) => new Promise(resolve => pending.push({ account: params.account, signal, resolve })));
  const render = (account = "account-a") => <VendorOverview sections={{ lead: "status", planWindows: "forecast", models: "models", traffic: "traffic", history: "history", provenance: "data", calibration: "calibration",
    projects: <WindowProjects key={account} account={account} from={projectWindowFixture.from} until={projectWindowFixture.until} /> }} />;
  try {
    await act(async () => root.render(render()));
    expect(read).toHaveBeenCalledTimes(0);
    const projectsTab = nodes(dom.host).find(node => node.attributes.role === "tab" && node.textContent === "Projects")!;
    await invoke(projectsTab, "onClick");
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => pending[0]!.resolve(projectWindowFixture));
    const projectButton = nodes(dom.host).find(node => node.tagName === "BUTTON" && node.textContent.includes("tokenAtlas ›"))!;
    await invoke(projectButton, "onClick", { currentTarget: projectButton });
    expect(nodes(dom.host).some(node => node.tagName === "DIALOG")).toBe(true);
    expect(dom.host.textContent).toContain("gpt-6.1-sol");
    await act(async () => root.render(render("account-b")));
    expect(dom.host.textContent).not.toContain("tokenAtlas");
    await act(async () => root.render(render("account-c")));
    expect(pending[1]!.signal?.aborted).toBe(true);
    await act(async () => pending[1]!.resolve({ ...projectWindowFixture, account: "account-b" }));
    expect(dom.host.textContent).not.toContain("tokenAtlas");
  } finally {
    await act(async () => root.unmount()); read.mockRestore(); dom.restore();
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor); else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("projects take distinct inks by token rank and Unassigned stays faint", () => {
  const project = (id: string | null, tokens: number) => ({ ...projectWindowFixture.projects[0]!, project_id: id, name: id, tokens });
  const colors = projectColors([project("small", 5), project(null, 900), project("big", 50), project("mid", 20)]);
  expect(colors.get("p:big")).toBe("var(--accent)");
  expect(colors.get("p:mid")).toBe("var(--claude)");
  expect(colors.get("p:small")).toBe("var(--violet)");
  expect(colors.get("unassigned")).toBe("var(--faint)");
  const many = projectColors(Array.from({ length: 10 }, (_, index) => project(`p${index}`, 100 - index)));
  expect(new Set([...many.values()].filter(color => color !== "var(--faint)")).size).toBe(10);
});

test("a running window ends shortly after now and bars widen until they stay visible", () => {
  const hour = 3_600_000, from = Date.parse("2026-10-17T20:40:00Z"), until = from + 7 * 24 * hour;
  expect(drawnEnd(from, until, until + hour)).toBe(until);
  const now = from + 36 * hour, end = drawnEnd(from, until, now);
  expect(end).toBeGreaterThan(now);
  expect(end - now).toBeLessThanOrEqual(2 * hour);
  expect(drawnEnd(from, until, from)).toBe(from + hour);
  expect(barStep(7 * 24 * hour, 1700)).toBe(hour);
  expect(barStep(7 * 24 * hour, 800)).toBe(3 * hour);
  expect(barStep(60 * 24 * hour, 900)).toBe(12 * hour);
  expect(barStep(200 * 24 * hour, 900)).toBe(24 * hour);
  const buckets = projectWindowBuckets(projectWindowFixture, 3 * hour);
  expect(buckets.reduce((sum, bucket) => sum + bucket.values.reduce((a, b) => a + b, 0), 0)).toBe(150);
  expect(buckets[0]!.from).toBe(Date.parse(projectWindowFixture.from));
});

test("the report's table is the chart legend, with a mini switch for all rows and no repeated headline", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  setLanguage("en");
  const rects = (name: string) => nodes(dom.host).filter(node => node.tagName === "RECT" && node.textContent.startsWith(`${name} · `));
  const dot = (name: string) => nodes(dom.host).find(node => node.tagName === "BUTTON" && node.attributes["aria-label"] === `${name} · on the chart`)!;
  const allSwitch = () => nodes(dom.host).find(node => node.tagName === "BUTTON" && (node.textContent === "hide all" || node.textContent === "show all"))!;
  try {
    await act(async () => root.render(<WindowProjectsReport data={projectWindowFixture} />));
    expect(nodes(dom.host).some(node => node.attributes["aria-label"] === "Project legend")).toBe(false);
    expect(nodes(dom.host).some(node => node.textContent === "Projects")).toBe(false);
    expect(rects("Unassigned").length).toBeGreaterThan(0);
    await invoke(dot("Unassigned"), "onClick");
    expect(rects("Unassigned")).toHaveLength(0);
    expect(dot("Unassigned").attributes["aria-pressed"]).toBe("false");
    expect(allSwitch().textContent).toBe("show all");
    await invoke(allSwitch(), "onClick");
    expect(rects("Unassigned").length).toBeGreaterThan(0);
    await invoke(allSwitch(), "onClick");
    expect(rects("tokenAtlas")).toHaveLength(0);
    expect(dom.host.textContent).toContain("No projects selected");
  } finally { await act(async () => root.unmount()); dom.restore(); }
});

test("a running window folds the time until its reset into a band", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  setLanguage("en");
  const hour = 3_600_000, from = Math.floor(Date.now() / hour) * hour - 30 * hour;
  const live: WindowProjectsResponse = { ...projectWindowFixture, from: new Date(from).toISOString(), until: new Date(from + 7 * 24 * hour).toISOString(),
    projects: projectWindowFixture.projects.map(project => ({ ...project, hours: [{ hour: new Date(from + 2 * hour).toISOString(), tokens: project.tokens, calls: 1 }] })) };
  try {
    await act(async () => root.render(<WindowProjectsReport data={live} />));
    expect(nodes(dom.host).filter(node => "data-reset-band" in node.attributes)).toHaveLength(1);
    await act(async () => root.render(<WindowProjectsReport key="ended" data={projectWindowFixture} />));
    expect(nodes(dom.host).filter(node => "data-reset-band" in node.attributes)).toHaveLength(0);
  } finally { await act(async () => root.unmount()); dom.restore(); }
});

test("standalone project charts clear hover and focus on removal without clearing another window", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  setLanguage("en");
  const other = { ...projectWindowFixture, account: "account-b" };
  const chart = (data: WindowProjectsResponse) => <SelectedProjectChart data={data} project={ALL_WINDOW_PROJECTS} usedPercent={80} />;
  const view = (showA = true, showB = false) => <><div key="a">{showA && chart(projectWindowFixture)}</div><div key="b">{showB && chart(other)}</div></>;
  const container = (index: number) => dom.host.children[index]!;
  const marks = (index: number) => nodes(container(index)).filter(node => node.tagName === "PATH");
  const legendButton = (index: number) => nodes(container(index)).find(node => node.tagName === "BUTTON" && node.textContent.includes("tokenAtlas") && "aria-pressed" in node.attributes)!;
  const clear = (index: number) => expect(marks(index).map(node => node.attributes.opacity)).toEqual(["1", "1"]);
  const highlighted = (index: number) => expect(marks(index).map(node => node.attributes.opacity)).toEqual(["1", "0.2"]);
  try {
    for (const handler of ["onMouseEnter", "onFocus"] as const) {
      await act(async () => root.render(view()));
      await invoke(legendButton(0), handler);
      highlighted(0);
      // Removing a chart need not deliver mouseleave or blur.
      await act(async () => root.render(view(false)));
      await act(async () => root.render(view()));
      clear(0);
    }
    await act(async () => root.render(view(true, true)));
    await invoke(legendButton(0), "onMouseEnter");
    highlighted(0);
    clear(1);
    await invoke(legendButton(1), "onFocus");
    clear(0);
    highlighted(1);
    // A late cleanup from another scope must preserve the active window's focus.
    await act(async () => root.render(view(false, true)));
    highlighted(1);
    await act(async () => root.render(view(false, false)));
    await act(async () => root.render(view(false, true)));
    clear(1);
  } finally { await act(async () => root.unmount()); dom.restore(); }
});
