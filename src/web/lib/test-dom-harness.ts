import { act } from "react";
import { preserveBrowserGlobals } from "./test-dom-globals";

export type TestDom = { host: TestNode; restore: () => void };

export type TestNode = {
  nodeType: number;
  nodeName: string;
  tagName: string;
  children: TestNode[];
  childNodes: TestNode[];
  style: Record<string, string> & { setProperty: (key: string, value: string) => void };
  attributes: Record<string, string>;
  ownerDocument: TestDocument | null;
  parentNode: TestNode | null;
  namespaceURI: string;
  className: string;
  id: string;
  _text: string;
  value: string;
  selected: boolean;
  defaultSelected: boolean;
  disabled: boolean;
  scrollCount: number;
  options?: TestNode[];
  __handlers: Record<string, Array<(...args: unknown[]) => void>>;
  appendChild: (child: TestNode) => TestNode;
  removeChild: (child: TestNode) => TestNode;
  insertBefore: (child: TestNode, reference: TestNode | null) => TestNode;
  setAttribute: (key: string, value: string) => void;
  getAttribute: (key: string) => string | null;
  removeAttribute: (key: string) => void;
  hasAttribute: (key: string) => boolean;
  addEventListener: (type: string, listener: (...args: unknown[]) => void) => void;
  removeEventListener: () => void;
  dispatchEvent: () => boolean;
  contains: (node: TestNode) => boolean;
  cloneNode: () => TestNode;
  focus: () => void;
  blur: () => void;
  scrollIntoView: () => void;
  showModal: () => void;
  close: () => void;
  textContent: string;
};

export type TestDocument = {
  nodeType: number;
  createElement: (tag: string) => TestNode;
  createElementNS: (namespace: string, tag: string) => TestNode;
  createTextNode: (text: string) => TestNode;
  createComment: () => TestNode;
  createDocumentFragment: () => TestNode;
  getElementById: (id: string) => TestNode | null;
  querySelector: () => null;
  querySelectorAll: () => [];
  addEventListener: (type: string, listener: (...args: unknown[]) => void) => void;
  removeEventListener: () => void;
  activeElement: TestNode | null;
  readyState: string;
  location: { href: string; origin: string; protocol: string };
  body: TestNode;
  documentElement: TestNode;
  head: TestNode;
  defaultView: typeof globalThis;
};

export function installTestDom(): TestDom {
  const restoreDom = preserveBrowserGlobals();
  function MiniNode(this: TestNode, tag: string) {
    this.nodeType = tag === "#text" ? 3 : 1;
    this.nodeName = String(tag).toUpperCase();
    this.tagName = this.nodeName;
    this.children = [];
    this.childNodes = this.children;
    const style = { setProperty(key: string, value: string) { style[key] = value; } } as TestNode["style"];
    this.style = style;
    this.attributes = {};
    this.ownerDocument = null;
    this.parentNode = null;
    this.namespaceURI = "http://www.w3.org/1999/xhtml";
    this.className = "";
    this.id = "";
    this._text = "";
    this.value = "";
    this.selected = false;
    this.defaultSelected = false;
    this.disabled = false;
    this.scrollCount = 0;
    this.__handlers = {};
  }
  MiniNode.prototype.showModal = function (this: TestNode) { this.setAttribute("open", ""); };
  MiniNode.prototype.close = function (this: TestNode) { this.removeAttribute("open"); };
  MiniNode.prototype.appendChild = function (this: TestNode, child: TestNode) {
    if (child.parentNode) child.parentNode.removeChild(child);
    this.children.push(child);
    child.parentNode = this;
    return child;
  };
  MiniNode.prototype.removeChild = function (this: TestNode, child: TestNode) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  };
  MiniNode.prototype.insertBefore = function (this: TestNode, child: TestNode, reference: TestNode | null) {
    if (child === reference) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index >= 0) this.children.splice(index, 0, child);
    else this.children.push(child);
    child.parentNode = this;
    return child;
  };
  MiniNode.prototype.setAttribute = function (this: TestNode, key: string, value: string) {
    this.attributes[key] = String(value);
    if (key === "class") this.className = String(value);
    if (key === "id") this.id = String(value);
  };
  MiniNode.prototype.getAttribute = function (this: TestNode, key: string) {
    return this.attributes[key] ?? null;
  };
  MiniNode.prototype.removeAttribute = function (this: TestNode, key: string) {
    delete this.attributes[key];
  };
  MiniNode.prototype.hasAttribute = function (this: TestNode, key: string) {
    return key in this.attributes;
  };
  MiniNode.prototype.addEventListener = function (this: TestNode, type: string, listener: (...args: unknown[]) => void) {
    (this.__handlers[type] ||= []).push(listener);
  };
  MiniNode.prototype.removeEventListener = function () {};
  MiniNode.prototype.dispatchEvent = function () { return true; };
  MiniNode.prototype.contains = function (this: TestNode, node: TestNode): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  };
  MiniNode.prototype.cloneNode = function (this: TestNode) {
    return new (MiniNode as unknown as { new (tag: string): TestNode })(this.tagName);
  };
  MiniNode.prototype.focus = function () {};
  MiniNode.prototype.blur = function () {};
  MiniNode.prototype.scrollIntoView = function (this: TestNode) { this.scrollCount += 1; };
  Object.defineProperty(MiniNode.prototype, "textContent", {
    get(this: TestNode) {
      if (this.nodeType === 3) return this._text;
      return this.children.map((child) => child.textContent).join("") || this._text || "";
    },
    set(this: TestNode, value: string) {
      this._text = String(value);
      this.children.length = 0;
    },
  });
  Object.defineProperty(MiniNode.prototype, "innerHTML", {
    get(this: TestNode) { return this.textContent; },
    set(this: TestNode, value: string) { this._text = String(value); },
  });
  Object.defineProperty(MiniNode.prototype, "firstChild", {
    get(this: TestNode) { return this.children[0] ?? null; },
  });
  Object.defineProperty(MiniNode.prototype, "lastChild", {
    get(this: TestNode) { return this.children[this.children.length - 1] ?? null; },
  });
  Object.defineProperty(MiniNode.prototype, "parentElement", {
    get(this: TestNode) { return this.parentNode; },
  });
  Object.defineProperty(MiniNode.prototype, "nextSibling", {
    get(this: TestNode) {
      if (!this.parentNode) return null;
      const index = this.parentNode.children.indexOf(this);
      return this.parentNode.children[index + 1] ?? null;
    },
  });
  Object.defineProperty(MiniNode.prototype, "previousSibling", {
    get(this: TestNode) {
      if (!this.parentNode) return null;
      const index = this.parentNode.children.indexOf(this);
      return this.parentNode.children[index - 1] ?? null;
    },
  });
  Object.defineProperty(MiniNode.prototype, "nodeValue", {
    get(this: TestNode) { return this._text || null; },
    set(this: TestNode, value: string) { this._text = value; },
  });
  Object.defineProperty(MiniNode.prototype, "options", {
    get(this: TestNode) {
      if (this.tagName !== "SELECT") return undefined;
      const options: TestNode[] = [];
      const visit = (nodes: TestNode[]) => {
        for (const node of nodes) node.tagName === "OPTION" ? options.push(node) : visit(node.children);
      };
      visit(this.children);
      return options;
    },
  });
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const addEventListener = (type: string, listener: (...args: unknown[]) => void) => {
    (listeners[type] ||= []).push(listener);
  };
  function HTMLIFrameElement() {}
  function HTMLElement() {}
  function Element() {}
  function Node() {}
  const documentLike = {
    nodeType: 9,
    createElement(tag: string) {
      const node = new (MiniNode as unknown as { new (tag: string): TestNode })(tag);
      node.ownerDocument = documentLike as TestDocument;
      return node;
    },
    createElementNS(namespace: string, tag: string) {
      const node = new (MiniNode as unknown as { new (tag: string): TestNode })(tag);
      node.ownerDocument = documentLike as TestDocument;
      node.namespaceURI = namespace;
      return node;
    },
    createTextNode(text: string) {
      const node = new (MiniNode as unknown as { new (tag: string): TestNode })("#text");
      node.nodeType = 3;
      node.nodeName = "#text";
      node._text = String(text);
      node.ownerDocument = documentLike as TestDocument;
      return node;
    },
    createComment() {
      const node = new (MiniNode as unknown as { new (tag: string): TestNode })("#comment");
      node.nodeType = 8;
      node.ownerDocument = documentLike as TestDocument;
      return node;
    },
    createDocumentFragment() {
      const node = new (MiniNode as unknown as { new (tag: string): TestNode })("#fragment");
      node.nodeType = 11;
      node.ownerDocument = documentLike as TestDocument;
      return node;
    },
    getElementById(id: string) {
      return allNodes(documentLike.body).find((node) => node.id === id) ?? null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener,
    removeEventListener() {},
    activeElement: null as TestNode | null,
    readyState: "complete",
    location: { href: "http://localhost/", origin: "http://localhost", protocol: "http:" },
    body: null as unknown as TestNode,
    documentElement: null as unknown as TestNode,
    head: null as unknown as TestNode,
    defaultView: globalThis,
  };
  documentLike.body = documentLike.createElement("body");
  documentLike.documentElement = documentLike.createElement("html");
  documentLike.head = documentLike.createElement("head");
  globalThis.document = documentLike as unknown as Document;
  globalThis.addEventListener = addEventListener as typeof globalThis.addEventListener;
  globalThis.removeEventListener = (() => {}) as typeof globalThis.removeEventListener;
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
  Object.defineProperty(globalThis, "self", { configurable: true, value: globalThis });
  globalThis.navigator = { userAgent: "bun-test" } as Navigator;
  globalThis.HTMLIFrameElement = HTMLIFrameElement as unknown as typeof globalThis.HTMLIFrameElement;
  globalThis.HTMLElement = HTMLElement as unknown as typeof globalThis.HTMLElement;
  globalThis.Element = Element as unknown as typeof globalThis.Element;
  globalThis.Node = Node as unknown as typeof globalThis.Node;
  globalThis.SVGElement = function SVGElement() {} as unknown as typeof globalThis.SVGElement;
  globalThis.getComputedStyle = () => new Proxy({}, { get: () => "" }) as CSSStyleDeclaration;
  // Layout hooks (useBreakpoint) schedule and cancel frames; restored with the other globals.
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((handle: number) => clearTimeout(handle)) as typeof globalThis.cancelAnimationFrame;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  documentLike.defaultView = globalThis;
  const host = documentLike.createElement("div");
  documentLike.body.appendChild(host);
  return { host, restore: restoreDom };
}

function allNodes(root: TestNode): TestNode[] {
  return [root, ...root.children.flatMap(allNodes)];
}

export function findByAttribute(root: TestNode, name: string, value: string): TestNode | null {
  return allNodes(root).find((node) => node.getAttribute(name) === value) ?? null;
}

export function findByText(root: TestNode, tag: string, value: string): TestNode | null {
  return allNodes(root).find((node) => node.tagName === tag && node.textContent === value) ?? null;
}

function reactProps(node: TestNode): Record<string, (...args: never[]) => unknown> {
  const key = Object.keys(node).find((candidate) => candidate.startsWith("__reactProps$"));
  if (!key) throw new Error(`React props missing on ${node.tagName}`);
  return (node as unknown as Record<string, Record<string, (...args: never[]) => unknown>>)[key]!;
}

export async function invoke(node: TestNode, prop: "onClick" | "onKeyDown" | "onPointerDown" | "onPointerMove" | "onPointerUp" | "onMouseEnter" | "onMouseLeave" | "onFocus" | "onBlur" | "onChange" | "onDragStart" | "onDrop" | "onSubmit" | "onCancel", argument?: unknown): Promise<void> {
  const handler = reactProps(node)[prop];
  if (!handler) throw new Error(`${prop} missing on ${node.tagName}`);
  await act(async () => {
    handler(argument as never);
  });
}

/** Picks an option of a Dropdown: opens it by its trigger, then clicks the option in the portalled list. */
export async function chooseOption(trigger: TestNode, value: string): Promise<void> {
  const option = (await openList(trigger)).find((node) => node.getAttribute("data-value") === value);
  if (!option) throw new Error(`option ${value} missing`);
  await invoke(option, "onClick");
}

/** The options a Dropdown lists, in order; opens it and leaves it open. */
export async function dropdownOptions(trigger: TestNode): Promise<{ value: string; label: string; disabled: boolean }[]> {
  return (await openList(trigger)).map((node) => ({
    value: node.getAttribute("data-value") ?? "",
    label: allNodes(node).find((child) => child.className === "ui-picker-title")?.textContent ?? "",
    disabled: node.getAttribute("aria-disabled") === "true",
  }));
}

/** The value a Dropdown holds, read from the option its list marks selected; a list it had to open is closed again. */
export async function dropdownValue(trigger: TestNode): Promise<string | null> {
  const wasOpen = trigger.getAttribute("aria-expanded") === "true";
  const selected = (await openList(trigger)).find((node) => node.getAttribute("aria-selected") === "true");
  if (!wasOpen) await invoke(trigger, "onClick");
  return selected?.getAttribute("data-value") ?? null;
}

// The option nodes of this trigger's own portalled list (several lists may be open in the fake DOM).
async function openList(trigger: TestNode): Promise<TestNode[]> {
  if (trigger.getAttribute("aria-haspopup") !== "listbox") throw new Error(`${trigger.tagName} is not a dropdown trigger`);
  if (trigger.getAttribute("aria-expanded") !== "true") await invoke(trigger, "onClick");
  const body = (globalThis.document as unknown as { body: TestNode }).body;
  const list = findByAttribute(body, "id", trigger.getAttribute("aria-controls") ?? "");
  if (!list) throw new Error("dropdown list missing");
  return allNodes(list).filter((node) => node.getAttribute("role") === "option");
}

/** The dropdown triggers under a node, in document order. */
export function dropdowns(root: TestNode): TestNode[] {
  return allNodes(root).filter((node) => node.tagName === "BUTTON" && node.getAttribute("aria-haspopup") === "listbox");
}

export async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await Promise.resolve();
    });
  }
  throw new Error("timed out waiting for mounted drawer to settle");
}
