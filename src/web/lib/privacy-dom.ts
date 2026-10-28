import { onPrivacyChange, onPrivacyIdentities, privateText, privacyEnabled } from "./privacy";

type Saved = { raw: string; masked: string; read: () => string; write: (value: string) => void };

/** Covers every screen, SVG titles and late-mounted portals without replacing React nodes.
 * This is screen-sharing privacy, not a redacted API or an access-control boundary.
 */
export function installPrivacyShield(doc: Document): () => void {
  const saved = new Map<Node, Map<string, Saved>>();
  const disabled = new Map<HTMLInputElement | HTMLTextAreaElement, boolean>();
  let observer: MutationObserver | null = null;
  const update = (node: Node, key: string, read: () => string, write: (value: string) => void, transform = privateText) => {
    const previous = saved.get(node)?.get(key), current = read();
    const raw = previous && current === previous.masked ? previous.raw : current;
    const masked = transform(raw);
    if (masked !== raw) {
      if (!saved.has(node)) saved.set(node, new Map());
      saved.get(node)!.set(key, { raw, masked, read, write });
    } else saved.get(node)?.delete(key);
    if (current !== masked) write(masked);
  };
  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      update(node, "text", () => node.nodeValue ?? "", value => { node.nodeValue = value; });
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as HTMLElement;
    // Reserved for static branding and navigation labels, never API-provided content.
    if (element.hasAttribute("data-privacy-public")) return;
    if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(element.tagName)) return;
    for (const name of ["title", "aria-label", "aria-description", "alt", "placeholder", "label"]) {
      if (element.hasAttribute(name)) update(node, name, () => element.getAttribute(name) ?? "", value => element.setAttribute(name, value));
    }
    if (element.hasAttribute("href")) update(node, "href", () => element.getAttribute("href") ?? "", value => element.setAttribute("href", value), value => privateText(value) === value ? value : "#");
    if ((element.tagName === "INPUT" && !["checkbox", "radio", "number", "range", "date", "datetime-local", "color", "hidden", "file"].includes((element as HTMLInputElement).type)) || element.tagName === "TEXTAREA") {
      const input = element as HTMLInputElement | HTMLTextAreaElement;
      update(node, "value", () => input.value, value => { input.value = value; });
      if (saved.get(node)?.has("value") && !disabled.has(input)) {
        disabled.set(input, input.disabled);
        input.disabled = true;
      }
    }
    for (const child of Array.from(node.childNodes)) visit(child);
  };
  const rescan = () => { if (privacyEnabled()) visit(doc.body); };
  const restore = () => {
    observer?.disconnect(); observer = null;
    for (const fields of saved.values()) for (const value of fields.values()) {
      // A newer React update wins over our old snapshot.
      if (value.read() === value.masked) value.write(value.raw);
    }
    for (const [input, wasDisabled] of disabled) input.disabled = wasDisabled;
    saved.clear(); disabled.clear();
  };
  const change = () => {
    if (!privacyEnabled()) { restore(); return; }
    if (observer) return;
    observer = new MutationObserver(records => {
      const targets = new Set<Node>();
      for (const record of records) targets.add(record.type === "characterData" ? record.target.parentNode ?? record.target : record.target);
      for (const target of targets) if (target.isConnected) visit(target);
      for (const node of saved.keys()) if (!node.isConnected) saved.delete(node);
      for (const node of disabled.keys()) if (!node.isConnected) disabled.delete(node);
    });
    observer.observe(doc.body, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ["title", "aria-label", "aria-description", "alt", "placeholder", "label", "href", "value"] });
    rescan();
  };
  const onInput = (event: Event) => {
    const target = event.target;
    queueMicrotask(() => { if (privacyEnabled() && target instanceof Node && target.isConnected) visit(target); });
  };
  doc.addEventListener("input", onInput, true);
  doc.addEventListener("change", onInput, true);
  const offPreference = onPrivacyChange(change), offIdentities = onPrivacyIdentities(rescan);
  change();
  return () => { offPreference(); offIdentities(); restore(); doc.removeEventListener("input", onInput, true); doc.removeEventListener("change", onInput, true); };
}
