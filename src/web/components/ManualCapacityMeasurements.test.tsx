import { expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ManualCapacityMeasurements } from "./ManualCapacityMeasurements";
import { api } from "../lib/api";
import { setLanguage } from "../lib/i18n";
import { findByAttribute, findByText, flushUntil, installTestDom, invoke, type TestNode } from "../lib/test-dom-harness";
import type { ManualCapacityStore } from "../../shared/manual-capacity";

function form(root: TestNode): TestNode | undefined {
  if (root.tagName === "FORM") return root;
  return root.children.map(form).find(Boolean);
}

test("users can enter, edit and remove a manual percentage and account switches reset the draft", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  let store: ManualCapacityStore = { revision: "empty", measurements: [] };
  const read = spyOn(api, "manualCapacity").mockImplementation(async (_provider, account) => ({ ...store, measurements: store.measurements.filter(m => m.account === account) }));
  const save = spyOn(api, "saveManualCapacity").mockImplementation(async (_provider, account, body) => {
    store = { revision: String(Number(store.revision) + 1 || 1), measurements: body.remove ? [] : [{ ...body.measurement!, id: body.measurement!.id ?? "one", account, updated_at: new Date().toISOString() }] };
    return store;
  });
  const changed: unknown[][] = [];
  const props = { provider: "claude", account: "a", since: "2026-08-10", until: "2026-08-10", windows: [], onSaved: (...args: unknown[]) => changed.push(args) };
  const field = (label: string) => findByAttribute(dom.host, "aria-label", label)!;
  const button = (label: string) => findByText(dom.host, "BUTTON", label)!;
  setLanguage("en");
  try {
    await act(async () => root.render(<ManualCapacityMeasurements {...props} />));
    expect(read).not.toHaveBeenCalled();
    await invoke(button("Enter / edit %"), "onClick");
    await flushUntil(() => !!form(dom.host));
    expect(field("Reading start").value).toBe("");
    expect(field("Start percentage").value).toBe("");
    await invoke(form(dom.host)!, "onSubmit", { preventDefault() {} });
    expect(save).not.toHaveBeenCalled();
    await invoke(field("Reading start"), "onChange", { target: { value: "2026-08-10T10:00:00" } });
    await invoke(field("Reading end"), "onChange", { target: { value: "2026-08-10T11:00:00" } });
    await invoke(field("Start percentage"), "onChange", { target: { value: "20" } });
    await invoke(field("End percentage"), "onChange", { target: { value: "40" } });
    await invoke(form(dom.host)!, "onSubmit", { preventDefault() {} });
    await flushUntil(() => dom.host.textContent.includes("Reading saved"));
    expect(save.mock.calls[0]![2]).toMatchObject({ revision: "empty", measurement: { start_percent: 20, end_percent: 40, approximate_time: false } });
    expect(changed[0]![1]).toBe(20);
    await invoke(field("End percentage"), "onChange", { target: { value: "60" } });
    await invoke(form(dom.host)!, "onSubmit", { preventDefault() {} });
    await flushUntil(() => changed.length === 2);
    expect(save.mock.calls[1]![2].measurement).toMatchObject({ id: "one", end_percent: 60 });
    expect(changed[1]![1]).toBe(40);
    await invoke(button("Remove manual reading"), "onClick");
    // Removal asks for confirmation first.
    expect(save).toHaveBeenCalledTimes(2);
    await invoke(button("Yes, remove"), "onClick");
    await flushUntil(() => changed.length === 3);
    expect(save.mock.calls[2]![2].remove).toBe("one");
    await act(async () => root.render(<ManualCapacityMeasurements {...props} account="b" />));
    await flushUntil(() => read.mock.calls.at(-1)?.[1] === "b" && !!form(dom.host));
    expect(findByText(dom.host, "BUTTON", "Remove manual reading")).toBeNull();
  } finally { await act(async () => root.unmount()); read.mockRestore(); save.mockRestore(); dom.restore(); }
});
