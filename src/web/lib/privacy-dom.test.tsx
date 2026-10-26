import { expect, test } from "bun:test";
import { installTestDom, type TestNode } from "./test-dom-harness";
import { installPrivacyShield } from "./privacy-dom";
import { learnPrivacyIdentities, setPrivacyEnabled } from "./privacy";

test("shield masks live text, SVG help, inputs and links, preserves selector IDs, restores newest values", () => {
  const dom = installTestDom();
  const previousObserver = globalThis.MutationObserver;
  let callback: MutationCallback = () => {};
  class Observer {
    constructor(fn: MutationCallback) { callback = fn; }
    observe() {} disconnect() {} takeRecords() { return []; }
  }
  globalThis.MutationObserver = Observer as unknown as typeof MutationObserver;
  const doc = dom.host.ownerDocument!;
  const nodes: TestNode[] = [];
  const node = (tag: string, text?: string) => {
    const n = tag === "#text" ? doc.createTextNode(text ?? "") : doc.createElement(tag);
    Object.defineProperty(n, "isConnected", { get: () => doc.body.contains(n) });
    nodes.push(n); return n;
  };
  Object.defineProperty(doc.body, "isConnected", { get: () => true });
  const label = node("span"), original = node("#text", "private-one@example.test · 70% · $1,400"); label.appendChild(original);
  label.setAttribute("title", "private-one@example.test"); label.setAttribute("aria-label", "private-one@example.test");
  const input = node("input"); input.value = "private-one@example.test";
  const select = node("select"), option = node("option"); option.value = "private-sub"; select.value = "private-sub";
  option.appendChild(node("#text", "private-sub")); select.appendChild(option);
  const link = node("a"); link.setAttribute("href", "mailto:private-one@example.test");
  const svg = node("svg"), title = node("title"); title.appendChild(node("#text", "private-one@example.test")); svg.appendChild(title);
  const brand = node("span"); brand.setAttribute("data-privacy-public", ""); brand.appendChild(node("#text", "tokenAtlas")); doc.body.appendChild(brand);
  for (const n of [label, input, select, link, svg]) doc.body.appendChild(n);
  const stop = installPrivacyShield(doc as unknown as Document);
  try {
    learnPrivacyIdentities({ subscription: "private-sub", projects: [{ id: "atlas", name: "tokenAtlas", matches: [] }] }); setPrivacyEnabled(true);
    expect(brand.textContent).toBe("tokenAtlas");
    expect(label.children[0]).toBe(original);
    expect(label.textContent).toBe(" · 70% · $1,400");
    expect(label.getAttribute("title")).toBe(""); expect(label.getAttribute("aria-label")).toBe("");
    expect(input.value).toBe(""); expect(input.disabled).toBe(true);
    expect(select.value).toBe("private-sub"); expect(option.value).toBe("private-sub"); expect(option.textContent).not.toBe("private-sub");
    expect(link.getAttribute("href")).toBe("#"); expect(title.textContent).toBe("");
    original._text = "private-two@example.test · 71%";
    callback([{ type: "characterData", target: original }] as unknown as MutationRecord[], {} as MutationObserver);
    expect(label.textContent).toBe(" · 71%");
    const portal = node("div"); portal.appendChild(node("#text", "late@example.test")); doc.body.appendChild(portal);
    callback([{ type: "childList", target: doc.body }] as unknown as MutationRecord[], {} as MutationObserver);
    expect(portal.textContent).toBe("");
    setPrivacyEnabled(false);
    expect(label.textContent).toBe("private-two@example.test · 71%");
    expect(label.getAttribute("title")).toBe("private-one@example.test");
    expect(input.value).toBe("private-one@example.test"); expect(input.disabled).toBe(false);
    expect(link.getAttribute("href")).toBe("mailto:private-one@example.test");
    expect(portal.textContent).toBe("late@example.test");
    expect(label.children[0]).toBe(original);
  } finally { stop(); setPrivacyEnabled(false); globalThis.MutationObserver = previousObserver; dom.restore(); }
});
