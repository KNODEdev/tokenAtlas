import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useI18n } from "../lib/i18n";
import { toneColor, type Tone } from "./ui";

/** `tone` draws a status dot; `group` files the option under its own heading after the providers. */
type Option = { value: string; vendor: string; label: string; detail?: string; tone?: Tone; group?: { id: string; label: string } };
const providers = ["codex", "claude", "gemini", "glm", "grok", "opencode"];
export const providerLabel = (vendor: string) => ({ codex: "Codex", claude: "Claude", gemini: "Gemini", glm: "GLM", grok: "Grok", opencode: "OpenCode" }[vendor] ?? vendor);
export function groupSourceSubscriptions(options: Option[]) {
  const grouped = new Map<string, { label: string; items: Option[] }>();
  for (const option of options) {
    const id = option.group?.id ?? option.vendor;
    const entry = grouped.get(id) ?? { label: option.group?.label ?? providerLabel(option.vendor), items: [] };
    entry.items.push(option);
    grouped.set(id, entry);
  }
  const rank = (id: string) => providers.includes(id) ? providers.indexOf(id) : options.some(option => option.group?.id === id) ? providers.length + 1 : providers.length;
  return [...grouped].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)).map(([vendor, { label, items }]) => ({
    vendor, label, options: items.sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value)),
  }));
}
const Dot = ({ tone }: { tone?: Tone }) => tone ? <i className="source-picker-dot" style={{ background: toneColor(tone) }} aria-hidden="true" /> : null;
export function SourceSubscriptionPicker({ value, options, onChange, input }: { value: string; options: Option[]; onChange: (value: string) => void;
  input?: { label: string; disabled: boolean } }) {
  const { t } = useI18n();
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const groups = groupSourceSubscriptions(options);
  const ordered = groups.flatMap(group => group.options);
  const selected = ordered.find(option => option.value === value);
  const focusValue = selected?.value ?? ordered[0]?.value;
  const optionId = (value: string) => `${id}-${encodeURIComponent(value)}`;
  const close = () => { setOpen(false); document.getElementById(id)?.focus(); };
  useEffect(() => {
    if (!open) return;
    if (focusValue) document.getElementById(`${id}-${encodeURIComponent(focusValue)}`)?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, focusValue, id]);
  const navigate = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    const index = ordered.findIndex(option => optionId(option.value) === document.activeElement?.id);
    const last = ordered.length - 1;
    let next = event.key === "Home" ? 0 : event.key === "End" ? last
      : event.key === "ArrowDown" ? (index + 1) % ordered.length
      : event.key === "ArrowUp" ? (index + last) % ordered.length : -1;
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && event.key !== " ") {
      const rotated = [...ordered.slice(index + 1), ...ordered.slice(0, index + 1)];
      const match = rotated.find(option => option.label.toLowerCase().startsWith(event.key.toLowerCase()));
      if (match) next = ordered.indexOf(match);
    }
    if (next < 0 || !ordered[next]) return;
    event.preventDefault(); document.getElementById(optionId(ordered[next]!.value))?.focus();
  };
  const trigger = <button id={id} type="button" className={input ? "source-profile-options" : "ui-selector is-strong source-picker-trigger"}
    disabled={input?.disabled} aria-label={input ? t("Detected profiles", "Wykryte profile") : t("Subscription to configure", "Abonament do konfiguracji")}
    aria-haspopup="menu" aria-expanded={open} aria-controls={`${id}-menu`}
    onClick={() => setOpen(!open)} onKeyDown={event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
      if (event.key === "Escape") close();
    }}>
    {!input && <><span className="source-picker-provider">{selected ? selected.group?.label ?? providerLabel(selected.vendor) : t("Subscription", "Abonament")}</span>
      <Dot tone={selected?.tone} /><strong>{selected?.label ?? "—"}</strong></>}
    <span className="ui-selector-caret">▾</span>
  </button>;
  return <div ref={root} className={`source-picker${input ? " source-picker-input" : ""}`} onBlur={event => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
  }}>
    {input ? <div className="source-profile-input"><input aria-label={input.label} className="ui-date-input mono" value={value} required disabled={input.disabled}
      onChange={event => { onChange(event.target.value); setOpen(false); }} />{trigger}</div> : trigger}
    {open && <div id={`${id}-menu`} className="source-picker-menu" role="menu" aria-labelledby={id} onKeyDown={navigate}>
      {groups.map(group => <div role="group" aria-label={group.label} key={group.vendor}>
        <div className="source-picker-heading">{group.label}</div>
        {group.options.map(option => <button key={option.value} id={optionId(option.value)} type="button" role="menuitemradio"
          aria-checked={value === option.value} aria-label={`${group.label} · ${option.label}`} tabIndex={-1}
          onClick={() => { onChange(option.value); close(); }}>
          <span><Dot tone={option.tone} />{option.label}{option.detail && <small>{option.detail}</small>}</span><span aria-hidden="true">{value === option.value ? "✓" : ""}</span>
        </button>)}
      </div>)}
      {!ordered.length && <div className="source-picker-heading">{t("No detected profiles", "Brak wykrytych profili")}</div>}
    </div>}
  </div>;
}
