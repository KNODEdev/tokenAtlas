/** Restore every global installed by the lightweight browser test fixtures.
 * Capture at installation time (not module import time); other test files share
 * the Bun process. Restore after React unmount so SSR never inherits a window.
 */
export function preserveBrowserGlobals(): () => void {
  const names = [
    "window", "self", "document", "navigator", "innerWidth", "innerHeight",
    "addEventListener", "removeEventListener", "HTMLIFrameElement", "HTMLElement",
    "Element", "Node", "SVGElement", "Event", "getComputedStyle",
    "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT",
  ];
  const descriptors = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
}
