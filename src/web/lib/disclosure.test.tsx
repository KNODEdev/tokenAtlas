import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { readDisclosure, useDisclosure } from "./disclosure";
import { findByText, installTestDom, invoke } from "./test-dom-harness";

function withStorage(values: Map<string, string>, failing = false) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => { if (failing) throw new Error("blocked"); return values.get(key) ?? null; },
    setItem: (key: string, value: string) => { if (failing) throw new Error("blocked"); values.set(key, value); },
  } });
  return () => { if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor); else Reflect.deleteProperty(globalThis, "localStorage"); };
}

function Block() {
  const [open, setOpen] = useDisclosure("test:block");
  return <button type="button" onClick={() => setOpen(!open)}>{open ? "open" : "closed"}</button>;
}

// IA-2026-10-19 v1.1, IA-43 (owner decision 20.10): detail blocks start open and remember the viewer's choice per block.
test("a detail block starts open, remembers its state and survives unavailable storage", async () => {
  const values = new Map<string, string>();
  const restore = withStorage(values);
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  try {
    expect(readDisclosure("test:block", true)).toBe(true);
    await act(async () => root.render(<Block />));
    await invoke(findByText(dom.host, "BUTTON", "open")!, "onClick");
    expect(values.get("tokenatlas.disclosure.v1:test:block")).toBe("0");
    await act(async () => root.unmount());
    const again = createRoot(dom.host as unknown as Element);
    await act(async () => again.render(<Block />));
    expect(findByText(dom.host, "BUTTON", "closed")).not.toBeNull();
    await act(async () => again.unmount());
  } finally { dom.restore(); restore(); }
  const restoreFailing = withStorage(new Map(), true);
  try { expect(readDisclosure("test:block", true)).toBe(true); } finally { restoreFailing(); }
});
