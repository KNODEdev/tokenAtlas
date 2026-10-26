import { expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { api, type ApiProject, type MergeRequest, type MergeResponse, type ProjectCostResponse, type SubjectRow } from "../lib/api";
import { setLanguage } from "../lib/i18n";
import { chooseOption, findByAttribute, findByText, flushUntil, installTestDom, invoke, type TestNode } from "../lib/test-dom-harness";
import { ProjectUsage } from "./ProjectUsage";

const alpha: SubjectRow = { kind: "project", id: "alpha", name: "Alpha", group: null,
  tokens: 100, calls: 2, active_seconds: 3600, repos: ["alpha"] };
const beta: SubjectRow = { ...alpha, kind: "repo", id: "/work/beta", name: "/work/beta", tokens: 900, repos: [] };
const bucket: SubjectRow = { ...alpha, id: "_tmp", name: "_TMP", tokens: 5000 };
const projects: ApiProject[] = [alpha, { ...alpha, id: "destination", name: "Destination" }, bucket].map(row => ({
  id: row.id, name: row.name, matches: [], tokens: row.tokens, calls: row.calls,
  first_ts: null, last_ts: null, vendors: {},
}));
function report(since: string | null, apiUsd = 70): ProjectCostResponse {
  const coverage = { tokens: 0, calls: 0, api_usd: 0, billed_usd: 0 };
  return {
    since, until: null, subscriptions: [], notes: [],
    subjects: [alpha, beta].map((row, i) => ({ subject: `${row.kind === "project" ? "p" : "r"}:${row.id}`,
      kind: row.kind, id: row.id, tokens: row.tokens, calls: row.calls, api_usd: i ? 20 : apiUsd - 20,
      billed_usd: 0, billed_complete: true, share_of_priced_spend_pct: null, priced_spend_usd: 0,
      by_sub: {}, subscriptions: {} })),
    totals: { tokens: 6000, calls: 6, api_usd: apiUsd, paid_usd: 0, billed_usd: 0,
      unassigned_billed_usd: 0, unassigned_api_usd: 0, non_tmp_tokens: 1000 },
    unpriced: { tokens: 0, models: {} },
    coverage: { tmp_bucket: { ...coverage, tokens: bucket.tokens }, unassigned: coverage,
      unpriced: { ...coverage, models: {} }, unattributable: { ...coverage, vendor: "gemini" }, totals: coverage },
  };
}
const merged: MergeResponse = { ok: true, project: { id: "destination", name: "Destination", matches: [] },
  absorbed: { repos: [beta.id], projects: [alpha.id] }, skipped: [], remap: null };
const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];
const rankingRows = (host: TestNode) => nodes(host).filter(node => node.tagName === "TR" && node.className.includes("projects-row"));
const button = (host: TestNode, label: string) => findByText(host, "BUTTON", label)!;
const selection = (host: TestNode, label: string) => findByAttribute(host, "aria-label", `Select ${label} to merge`)!;

function installUsageDom() {
  const dom = installTestDom();
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: document.location });
  return { host: dom.host, restore() {
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
    else Reflect.deleteProperty(globalThis, "location");
    dom.restore();
  } };
}

test("ranking sorting, row selection and existing-project merge retain scope and invalidate the old cost", async () => {
  setLanguage("en");
  const dom = installUsageDom(), root = createRoot(dom.host as unknown as Element);
  const subjects = spyOn(api, "subjects").mockImplementation(async params => ({
    subjects: [alpha, beta, bucket], since: params?.since ?? null, until: null, idle_gap_minutes: params?.idle_gap ?? 15,
  }));
  let resolveCost!: (value: ProjectCostResponse) => void;
  const cost = spyOn(api, "projectCost").mockImplementation(async params => subjects.mock.calls.length <= 1
    ? report(params?.since ?? null)
    : new Promise<ProjectCostResponse>(resolve => { resolveCost = resolve; }));
  let resolveMerge!: (value: MergeResponse) => void;
  const merge = spyOn(api, "projectsMerge").mockImplementation(() => new Promise(resolve => { resolveMerge = resolve; }));
  const history = spyOn(globalThis, "fetch").mockImplementation(Object.assign(
    () => new Promise<Response>(() => {}), { preconnect() {} },
  ));
  let changed = 0;
  try {
    await act(async () => root.render(<ProjectUsage projects={projects} onChanged={() => changed++} />));
    await flushUntil(() => rankingRows(dom.host).length === 2);
    expect(rankingRows(dom.host)[0]!.textContent).toContain("Alpha");
    expect(selection(dom.host, "_TMP")).toBeNull();
    await invoke(button(dom.host, "Tokens"), "onClick");
    expect(rankingRows(dom.host)[0]!.textContent).toContain("/work/beta");
    await invoke(rankingRows(dom.host)[0]!, "onClick");
    expect(findByAttribute(dom.host, "aria-label", "Close drawer")).not.toBeNull();
    await invoke(findByAttribute(dom.host, "aria-label", "Close drawer")!, "onClick");
    let stopped = false;
    await invoke(selection(dom.host, "Alpha"), "onClick", { stopPropagation() { stopped = true; } });
    expect(stopped).toBe(true);
    expect(findByAttribute(dom.host, "aria-label", "Close drawer")).toBeNull();
    await invoke(selection(dom.host, "Alpha"), "onChange");
    await invoke(selection(dom.host, "/work/beta"), "onChange");
    const target = findByAttribute(dom.host, "aria-label", "merge into")!;
    await chooseOption(target, "destination");
    await invoke(button(dom.host, "merge and remap"), "onClick");
    expect(merge.mock.calls).toEqual([[{ subjects: [{ kind: "repo", id: beta.id }, { kind: "project", id: alpha.id }], project_id: "destination" }]]);
    expect(button(dom.host, "merging…").hasAttribute("disabled")).toBe(true);
    expect(button(dom.host, "clear").hasAttribute("disabled")).toBe(true);
    await act(async () => resolveMerge(merged));
    await flushUntil(() => cost.mock.calls.length === 2);
    expect(changed).toBe(1);
    expect(findByAttribute(dom.host, "aria-label", "merge into")).toBeNull();
    expect((selection(dom.host, "Alpha") as TestNode & { checked: boolean }).checked).toBe(false);
    expect(dom.host.textContent).not.toContain("$70");
    expect(subjects.mock.calls.length).toBe(2);
    expect(cost.mock.calls[1]![0]?.since).toBe(cost.mock.calls[0]![0]?.since);
    await act(async () => resolveCost(report(cost.mock.calls[1]![0]?.since ?? null, 200)));
    expect(dom.host.textContent).toContain("$200");
    expect(rankingRows(dom.host)[0]!.textContent).toContain("/work/beta");
  } finally {
    await act(async () => root.unmount());
    subjects.mockRestore(); cost.mockRestore(); merge.mockRestore(); history.mockRestore(); dom.restore();
  }
});

test("new-project merge keeps edited fields and selected rows after failure and retries the same request", async () => {
  setLanguage("en");
  const dom = installUsageDom(), root = createRoot(dom.host as unknown as Element);
  const subjects = spyOn(api, "subjects").mockImplementation(async params => ({
    subjects: [beta], since: params?.since ?? null, until: null, idle_gap_minutes: params?.idle_gap ?? 15,
  }));
  const cost = spyOn(api, "projectCost").mockImplementation(async params => report(params?.since ?? null));
  const merge = spyOn(api, "projectsMerge").mockRejectedValueOnce(new Error("merge unavailable")).mockResolvedValue(merged);
  let changed = 0;
  try {
    await act(async () => root.render(<ProjectUsage projects={projects} onChanged={() => changed++} />));
    await flushUntil(() => rankingRows(dom.host).length === 1);
    await invoke(selection(dom.host, "/work/beta"), "onChange");
    expect(findByAttribute(dom.host, "aria-label", "Project name")!.value).toBe("beta");
    await invoke(findByAttribute(dom.host, "aria-label", "Project name")!, "onChange", { target: { value: "Combined Atlas" } });
    expect(findByAttribute(dom.host, "aria-label", "Project ID")!.value).toBe("combined-atlas");
    await invoke(findByAttribute(dom.host, "aria-label", "Project ID")!, "onChange", { target: { value: "custom-id" } });
    await invoke(button(dom.host, "merge and remap"), "onClick");
    expect(dom.host.textContent).toContain("merge unavailable");
    expect(changed).toBe(0);
    expect(findByAttribute(dom.host, "aria-label", "Project name")!.value).toBe("Combined Atlas");
    expect(findByAttribute(dom.host, "aria-label", "Project ID")!.value).toBe("custom-id");
    expect(button(dom.host, "merge and remap").hasAttribute("disabled")).toBe(false);
    await invoke(button(dom.host, "merge and remap"), "onClick");
    const expected: MergeRequest = { subjects: [{ kind: "repo", id: beta.id }], new: { id: "custom-id", name: "Combined Atlas" } };
    expect(merge.mock.calls).toEqual([[expected], [expected]]);
    expect(changed).toBe(1);
    expect(findByAttribute(dom.host, "aria-label", "merge into")).toBeNull();
    expect(dom.host.textContent).not.toContain("merge unavailable");
  } finally {
    await act(async () => root.unmount());
    subjects.mockRestore(); cost.mockRestore(); merge.mockRestore(); dom.restore();
  }
});
