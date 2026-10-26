import { expect, test, spyOn } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { api, type PlanSettingRow } from "../lib/api";
import { installTestDom, invoke, findByText, type TestNode } from "../lib/test-dom-harness";
import { setLanguage } from "../lib/i18n";
import { CapacityPromotionsPanel } from "./CapacityPromotionsPanel";

const row: PlanSettingRow = { subscription: "codex1", vendor: "codex", fallback_usd_per_month: 200,
  plan_on_day: { plan: "pro", plan_id: "codex-pro-20x", basis: "declared", from: "2026-01-01", until: null }, capacity_regimes: [] };
const catalog = { provider_groups: [] };
const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];
function labelled(host: TestNode, text: string) {
  const label = nodes(host).find(n => n.tagName === "LABEL" && n.textContent.startsWith(text));
  return nodes(label!).find(n => ["INPUT", "SELECT", "BUTTON"].includes(n.tagName))!;
}
function announcement(host: TestNode, title: string) {
  return nodes(host).find(n => n.className === "capacity-promotion-source" && n.textContent.includes(title))!;
}

test("editor saves an explicit dated 2x account declaration, preserves metadata and exposes recoverable disable", async () => {
  setLanguage("en");
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
  let reloads = 0;
  const save = spyOn(api, "plansSave").mockImplementation(async body => ({ ok: true, rows: [{ ...row, capacity_regimes: body.capacity_regimes?.map(r => ({ ...r, subscription: row.subscription })) }] }));
  try {
    await act(async () => { root.render(<CapacityPromotionsPanel rows={[row]} catalog={catalog} onSaved={() => reloads++} />); });
    const use = findByText(announcement(dom.host, "Codex app launch: double rate limits"), "BUTTON", "Use as an unconfirmed draft")!;
    await invoke(use, "onClick");
    expect(labelled(dom.host, "From (UTC)").value).toBe("2026-02-02");
    expect(labelled(dom.host, "Through (UTC)").value).toBe("");
    expect(labelled(dom.host, "Multiplier").value).toBe("2");
    expect((labelled(dom.host, "Confirmed") as TestNode & { checked: boolean }).checked).toBe(false);
    // One account's single subscription has no picker.
    expect(nodes(dom.host).some(n => n.tagName === "LABEL" && n.textContent.startsWith("Subscription"))).toBe(false);
    expect(save).not.toHaveBeenCalled();
    await invoke(labelled(dom.host, "From (UTC)"), "onChange", { target: { value: "2026-09-01" } });
    await invoke(labelled(dom.host, "Through (UTC)"), "onChange", { target: { value: "2026-09-30" } });
    await invoke(labelled(dom.host, "Confirmed"), "onChange", { target: { checked: true } });
    await invoke(nodes(dom.host).find(n => n.tagName === "FORM")!, "onSubmit", { preventDefault() {} });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).not.toHaveProperty("segments");
    expect(save.mock.calls[0]![0]).toMatchObject({ subscription: "codex1", expected_capacity_regimes: [], capacity_regimes: [{ from: "2026-09-01", until: "2026-09-30", factor: 2, confirmed: true, enabled: true, source: "user" }] });
    expect(reloads).toBe(1);
    expect(dom.host.textContent).toContain("Saved. Reopen statistics");
    expect(labelled(dom.host, "Multiplier").value).toBe("2");
    await invoke(labelled(dom.host, "Enabled"), "onChange", { target: { checked: false } });
    await invoke(nodes(dom.host).find(n => n.tagName === "FORM")!, "onSubmit", { preventDefault() {} });
    expect(save.mock.calls[1]![0].capacity_regimes![0]!.enabled).toBe(false);
    expect(save.mock.calls[1]![0].expected_capacity_regimes![0]!.enabled).toBe(true);
  } finally { save.mockRestore(); await act(async () => root.unmount()); dom.restore(); }
});

test("every Codex account gets the shipped history without private periods; resets and window policies have no multiplier draft", () => {
  setLanguage("en");
  for (const subscription of ["codex1", "new-account"]) {
    const html = renderToStaticMarkup(<CapacityPromotionsPanel rows={[{ ...row, subscription }]} catalog={catalog} onSaved={() => {}} />);
    expect(html).toContain("No declared periods");
    expect(html).toContain("GPT-5.6 Sol launch: two usage resets");
    expect(html).toContain("Five-hour limit temporarily lifted");
    expect(html).toContain("GPT-6 Astra launch: banked resets");
    expect(html.match(/Use as an unconfirmed draft/g)).toHaveLength(3);
  }
});

test("the Pro $100 global draft retains its end date and 5x plan scope even on a Pro 20x account", async () => {
  setLanguage("en");
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
  const save = spyOn(api, "plansSave").mockImplementation(async body => ({ ok: true, rows: [{ ...row, capacity_regimes: body.capacity_regimes?.map(r => ({ ...r, subscription: row.subscription })) }] }));
  try {
    await act(async () => { root.render(<CapacityPromotionsPanel rows={[row]} catalog={catalog} onSaved={() => {}} />); });
    for (const title of ["GPT-5.6 Sol launch: two usage resets", "Five-hour limit temporarily lifted", "December–January: 50% token discount", "Pro $200: 20× → 10× usage announced"]) {
      expect(findByText(announcement(dom.host, title), "BUTTON", "Use as an unconfirmed draft")).toBeNull();
    }
    await invoke(findByText(announcement(dom.host, "Pro $100: 10× Plus usage instead of 5×"), "BUTTON", "Use as an unconfirmed draft")!, "onClick");
    expect(labelled(dom.host, "From (UTC)").value).toBe("2026-04-09");
    expect(labelled(dom.host, "Through (UTC)").value).toBe("2026-05-31");
    expect(labelled(dom.host, "Plan").textContent).toContain("codex-pro-5x");
    expect(labelled(dom.host, "Meter").textContent).toContain("Weekly (main)");
    expect(save).not.toHaveBeenCalled();
    await invoke(nodes(dom.host).find(n => n.tagName === "FORM")!, "onSubmit", { preventDefault() {} });
    expect(save.mock.calls[0]![0]).toMatchObject({ subscription: "codex1", capacity_regimes: [{ until: "2026-05-31", plan_id: "codex-pro-5x", window_kind: "weekly", confirmed: false }] });
  } finally { save.mockRestore(); await act(async () => root.unmount()); dom.restore(); }
});

test("failed save retains the draft and displays the server conflict instead of reporting success", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
  const save = spyOn(api, "plansSave").mockRejectedValue(new Error("Changed in another editor"));
  try {
    await act(async () => { root.render(<CapacityPromotionsPanel rows={[row]} catalog={catalog} onSaved={() => { throw new Error("must not reload"); }} />); });
    await invoke(findByText(dom.host, "BUTTON", "+ Add period")!, "onClick");
    await invoke(nodes(dom.host).find(n => n.tagName === "FORM")!, "onSubmit", { preventDefault() {} });
    expect(dom.host.textContent).toContain("Changed in another editor");
    expect(dom.host.textContent).not.toContain("Saved.");
    expect(labelled(dom.host, "Multiplier").value).toBe("1");
    await invoke(findByText(dom.host, "BUTTON", "Discard changes")!, "onClick");
    expect(dom.host.textContent).toContain("No declared periods");
  } finally { save.mockRestore(); await act(async () => root.unmount()); dom.restore(); }
});

test("an account with a billing variant picks between its subscriptions, locked while a draft is unsaved", async () => {
  setLanguage("en");
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
  try {
    await act(async () => { root.render(<CapacityPromotionsPanel rows={[row, { ...row, subscription: "codex1::business" }]} catalog={catalog} onSaved={() => {}} />); });
    expect(labelled(dom.host, "Subscription").hasAttribute("disabled")).toBe(false);
    await invoke(findByText(dom.host, "BUTTON", "+ Add period")!, "onClick");
    expect(labelled(dom.host, "Subscription").hasAttribute("disabled")).toBe(true);
  } finally { await act(async () => root.unmount()); dom.restore(); }
});

test("Polish editor distinguishes editable declarations from immutable source announcements", () => {
  try {
    setLanguage("pl");
    const html = renderToStaticMarkup(<CapacityPromotionsPanel rows={[row]} catalog={catalog} onSaved={() => {}} />);
    expect(html).toContain("Promocje i pojemność");
    expect(html).toContain("Historyczne promocje i źródła");
    expect(html).toContain("Użyj jako niepotwierdzonego szkicu");
    expect(html).toContain('type="button">+ Dodaj okres');
  } finally { setLanguage("en"); }
});
