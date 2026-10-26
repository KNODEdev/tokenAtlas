import { expect, test } from "bun:test";
import { preserveBrowserGlobals } from "./test-dom-globals";

test("browser fixtures restore SSR absence and complete original descriptors", () => {
  const restoreOriginal = preserveBrowserGlobals();
  try {
    Reflect.deleteProperty(globalThis, "window");
    Object.defineProperty(globalThis, "innerWidth", { configurable: true, value: 123, writable: false });
    const originalWidth = Object.getOwnPropertyDescriptor(globalThis, "innerWidth");
    const restore = preserveBrowserGlobals();
    Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
    Object.defineProperty(globalThis, "innerWidth", { configurable: true, value: 1920, writable: true });
    restore();
    expect(typeof window).toBe("undefined");
    expect(Object.getOwnPropertyDescriptor(globalThis, "innerWidth")).toEqual(originalWidth);
    // A second cleanup cannot overwrite a newer fixture's values.
    Object.defineProperty(globalThis, "innerWidth", { configurable: true, value: 640 });
    restore();
    expect(globalThis.innerWidth).toBe(640);
  } finally {
    restoreOriginal();
  }
});

test("nested browser fixtures restore the caller's environment before restoring SSR", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const outer = preserveBrowserGlobals();
  try {
    const outerWindow = {};
    Object.defineProperty(globalThis, "window", { configurable: true, value: outerWindow });
    const inner = preserveBrowserGlobals();
    Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
    inner();
    expect(globalThis.window).toBe(outerWindow as Window & typeof globalThis);
  } finally {
    outer();
  }
  expect(Object.getOwnPropertyDescriptor(globalThis, "window")).toEqual(originalWindow);
});
