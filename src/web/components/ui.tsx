import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { useBreakpoint } from "../lib/useBreakpoint";
import { useI18n } from "../lib/i18n";
import { LoadingSkeleton, LoadingStatus, type LoadingShape } from "./LoadingStatus";
import "./ui.css";
import { DataTable } from "./DataTable";
export { DataTable, TableRow, TableColGroup } from "./DataTable";
/** Data text (the former monospace voice); see docs/design/paper-atlas.md. */
export const MONO = "var(--font-mono)";
export function Card({
  children,
  style,
  pad = "14px 16px",
  frame = true,
}: {
  children: ReactNode;
  style?: CSSProperties;
  pad?: string;
  /** False for a page's lead block that stands on the page itself (paper-atlas: no frame around a whole page). */
  frame?: boolean;
}) {
  return (
    <div className="ui-card" data-frame={frame ? undefined : "none"} style={{ ...(pad !== "14px 16px" ? { padding: pad } : {}), ...style }}>
      {children}
    </div>
  );
}
export function Eyebrow({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="mono ui-eyebrow" style={style}>
      {children}
    </div>
  );
}
/** `sub` is a short meta line (counts, scope, a warning); definitions and how-to-read go to `help`, the dot beside the title. */
export function CardTitle({ title, sub, right, help }: { title: string; sub?: string; right?: ReactNode; help?: ReactNode }) {
  return (
    <div className="ui-card-title">
      <div className="ui-card-title-content">
        <div className="ui-card-title-text">{title}{help != null && help !== false && <> <HelpDot label={title}>{help}</HelpDot></>}</div>
        {sub && (
          <div className="mono ui-card-subtitle">
            {sub}
          </div>
        )}
      </div>
      {right}
    </div>
  );
}
export type Tone = "neutral" | "accent" | "ok" | "warn" | "crit" | "violet";
const TONE: Record<Tone, { fg: string; soft: string }> = {
  neutral: { fg: "var(--muted)", soft: "var(--raised)" },
  accent: { fg: "var(--accent)", soft: "var(--accent-soft)" },
  ok: { fg: "var(--ok)", soft: "var(--ok-soft)" },
  warn: { fg: "var(--warn)", soft: "var(--warn-soft)" },
  crit: { fg: "var(--crit)", soft: "var(--crit-soft)" },
  violet: { fg: "var(--violet)", soft: "var(--accent-soft)" },
};
export function toneColor(t: Tone): string {
  return TONE[t].fg;
}
export function Pill({ tone = "neutral", dot, children }: { tone?: Tone; dot?: boolean; children: ReactNode }) {
  const c = TONE[tone];
  return (
    <span className={`ui-pill${tone === "neutral" ? " is-neutral" : ""}`} style={{ "--pill-tone": c.fg } as CSSProperties}>
      {(dot || tone !== "neutral") && <span className="ui-pill-dot" />}
      {children}
    </span>
  );
}
export function EstimateTag({ title, children = "estimated" }: { title?: string; children?: ReactNode }) {
  const { t } = useI18n();
  return (
    <span className="ui-tag" title={title} style={{ cursor: title ? "help" : "default" }}>
      {children === "estimated" ? t("estimated", "szacunek") : children}
    </span>
  );
}
export interface KpiSpec {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  color?: string;
  title?: string;
  absent?: boolean;
  comparison?: { value: string; title: string };
}
export function KpiStrip({ items, columns }: { items: KpiSpec[]; columns?: number }) {
  const bp = useBreakpoint();
  const requested = columns ?? items.length;
  const cap = bp === "mobile" ? 2 : bp === "tablet" ? 3 : requested;
  const cols = Math.min(requested, cap);
  return (
    <section className="ui-kpi-strip" style={{ "--kpi-columns": cols } as CSSProperties}>
      {items.map((k, i) => (
        <div key={i} className={`ui-kpi-cell${k.absent ? " ui-kpi-absent" : ""}`} title={k.title} style={k.comparison ? { position: "relative", paddingBottom: 23 } : undefined}>
          <div className="ui-kpi-label">{k.label}</div>
          {k.comparison && <span className="mono ui-kpi-comparison" title={k.comparison.title}>{k.comparison.value}</span>}
          <div className="ui-figure ui-kpi-value" style={!k.absent && k.color ? { color: k.color } : undefined}>
            {k.value}
          </div>
          {k.note != null && <div className="ui-kpi-note">{k.note}</div>}
        </div>
      ))}
      {Array.from({ length: (cols - (items.length % cols)) % cols }, (_, i) => (
        <div key={`pad-${i}`} className="ui-kpi-pad" />
      ))}
    </section>
  );
}

export function Bar({
  value,
  color = "var(--accent)",
  height = 8,
  track = "var(--sunk)",
}: {
  value: number;
  color?: string;
  height?: number;
  track?: string;
}) {
  return (
    <div className="ui-bar" style={{ height, background: track }}>
      <div className="ui-bar-fill" style={{ width: `${Math.max(0, Math.min(100, value))}%`, backgroundColor: color }} />
    </div>
  );
}
/** `fixed`: the columns keep their declared widths and long cells are clipped instead of widening the table. */
export function Table({ children, fixed, tableId }: { children: ReactNode; fixed?: boolean; tableId: string }) {
  return (
    <div className="ui-table-wrap">
      <DataTable tableId={tableId} className={`ui-table${fixed ? " is-fixed" : ""}`}>{children}</DataTable>
    </div>
  );
}
export function Th({
  children,
  align = "left",
  title,
  columnId,
  className,
}: {
  children: ReactNode;
  align?: "left" | "right" | "center";
  title?: string;
  columnId?: string;
  className?: string;
  /** Read by the table's column chooser: the column starts hidden until chosen (IA-43). */
  defaultHidden?: boolean;
}) {
  return (
    <th className={`ui-th${className ? ` ${className}` : ""}`} data-column-id={columnId} title={title} style={{ textAlign: align }}>
      {children}
    </th>
  );
}
export function Td({
  children,
  align = "left",
  mono,
  style,
  colSpan,
  title,
}: {
  children: ReactNode;
  align?: "left" | "right" | "center";
  mono?: boolean;
  style?: CSSProperties;
  colSpan?: number;
  title?: string;
}) {
  return (
    <td className={mono ? "ui-td is-num" : "ui-td"} colSpan={colSpan} title={title} style={{ textAlign: align, ...style }}>
      {children}
    </td>
  );
}
export function Selector({
  label,
  value,
  onChange,
  options,
  strong,
  ariaLabel,
  bare,
  disabled,
  title,
  className,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
  strong?: boolean;
  ariaLabel?: string;
  /** No frame and no visible label (it moves to the tooltip): a value inside a chart's control row. */
  bare?: boolean;
  /** Keeps the control in its place while the current view does not use it. */
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <label className={`hoverline ui-selector${strong ? " is-strong" : ""}${bare ? " is-bare" : ""}${disabled ? " is-disabled" : ""}${className ? ` ${className}` : ""}`} title={title ?? (bare ? label : undefined)}>
      {label && !bare && <span className="mono ui-selector-label">{label}</span>}
      {/* The selector's frame stays the field; the dropdown inside it is bare. */}
      <Dropdown value={value} onChange={onChange} options={options} ariaLabel={ariaLabel ?? label} disabled={disabled} className="ui-selector-field" />
    </label>
  );
}
export interface PickerOption {
  value: string;
  title: string;
  /** Section the option is listed under (e.g. the vendor); options without one come first. */
  group?: string;
  groupColor?: string;
  /** Short qualifier shown as a chip (e.g. the plan). */
  tag?: string | null;
  /** Listed after the rest of its group, dimmed (e.g. an inactive subscription). */
  muted?: boolean;
}
interface PickerSection { group?: string; color?: string; items: PickerOption[]; muted: PickerOption[] }
/**
 * A long choice as a grouped list in the app's own popover (a native select cannot group, dim or
 * search). Arrow keys move, Enter picks, Escape closes, typing filters.
 */
export function Picker({
  label,
  value,
  onChange,
  options,
  ariaLabel,
  mutedLabel,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  options: PickerOption[];
  ariaLabel?: string;
  /** Caption above the dimmed options of a group. */
  mutedLabel?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const q = query.trim().toLowerCase();
  const sections: PickerSection[] = [];
  for (const option of options) {
    if (q && !`${option.title} ${option.group ?? ""} ${option.tag ?? ""}`.toLowerCase().includes(q)) continue;
    let section = sections.find((s) => s.group === option.group);
    if (!section) sections.push((section = { group: option.group, color: option.groupColor, items: [], muted: [] }));
    (option.muted ? section.muted : section.items).push(option);
  }
  sections.sort((a, b) => (a.group ? 1 : 0) - (b.group ? 1 : 0));
  const flat = sections.flatMap((s) => [...s.items, ...s.muted]);
  const optionId = (v: string) => `${listId}-${flat.findIndex((o) => o.value === v)}`;
  useEffect(() => {
    if (open && active) document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
  });
  const current = options.find((o) => o.value === value);
  const close = () => { setOpen(false); setQuery(""); trigger.current?.focus(); };
  const choose = (v: string) => { onChange(v); close(); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!open) return;
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (event.key === "Enter" && active) { event.preventDefault(); choose(active); return; }
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!step || flat.length === 0) return;
    event.preventDefault();
    const index = flat.findIndex((o) => o.value === active);
    setActive(flat[(index + step + flat.length) % flat.length]!.value);
  };
  const renderOption = (o: PickerOption) => (
    <li key={o.value} id={optionId(o.value)} role="option" data-value={o.value} aria-selected={o.value === value}
      className={`ui-picker-option${o.group ? "" : " is-root"}${o.value === active ? " is-active" : ""}${o.muted ? " is-muted" : ""}`}
      onMouseEnter={() => setActive(o.value)} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(o.value)}>
      <span className="ui-picker-title">{o.title}</span>
      {o.tag && <span className="ui-picker-tag">{o.tag}</span>}
      <span className="ui-picker-check" aria-hidden="true">{o.value === value ? "✓" : ""}</span>
    </li>
  );
  return (
    <div className="ui-picker" ref={root} onKeyDown={onKeyDown}>
      <button ref={trigger} type="button" className="hoverline ui-selector is-strong ui-picker-trigger" aria-haspopup="listbox"
        aria-expanded={open} aria-controls={open ? listId : undefined} aria-label={ariaLabel}
        onClick={() => { if (open) close(); else { setOpen(true); setActive(value); } }}>
        {label && <span className="ui-selector-label">{label}</span>}
        {current?.groupColor && <span className="ui-picker-dot" style={{ background: current.groupColor }} />}
        <span className="ui-picker-value">{current ? `${current.group ? `${current.group} · ` : ""}${current.title}` : value}</span>
        {current?.tag && <span className="ui-picker-tag">{current.tag}</span>}
        <span className="ui-selector-caret">&#9662;</span>
      </button>
      {open && (
        <div className="ui-picker-pop">
          {options.length > 8 && (
            <input autoFocus className="ui-input ui-picker-search" value={query} placeholder={t("Search…", "Szukaj…")}
              aria-label={t("Filter the list", "Filtruj listę")} aria-controls={listId}
              aria-activedescendant={active ? optionId(active) : undefined}
              onChange={(event) => { setQuery(event.target.value); setActive(null); }} />
          )}
          <ul role="listbox" id={listId} aria-label={ariaLabel ?? label} className="ui-picker-list">
            {sections.map((s) => (
              <Fragment key={s.group ?? ""}>
                {s.group && (
                  <li role="presentation" className="ui-picker-group">
                    {s.color && <span className="ui-picker-dot" style={{ background: s.color }} />}
                    {s.group}
                    <span className="ui-picker-count">{s.items.length + s.muted.length}</span>
                  </li>
                )}
                {s.items.map(renderOption)}
                {s.muted.length > 0 && mutedLabel && <li role="presentation" className="ui-picker-sub">{mutedLabel}</li>}
                {s.muted.map(renderOption)}
              </Fragment>
            ))}
            {flat.length === 0 && <li role="presentation" className="ui-picker-empty">{t("Nothing matches", "Brak pasujących")}</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
export interface DropdownOption { value: string; label: string; disabled?: boolean }
/**
 * The app's single-choice field: a native select's list is drawn by the operating system and cannot follow
 * the paper style, so the list opens in the app's popover instead. It is portalled with fixed coordinates, so
 * drawers and clipped cards do not cut it off. Closed: arrows, Enter or Space open it. Open: arrows move,
 * Enter picks, Escape or Tab closes, and a long list (more than 8 options) can be filtered by typing.
 */
export function Dropdown({ value, onChange, options, ariaLabel, disabled, required, className = "ui-input", id, style, ...data }: {
  value: string;
  onChange: (value: string) => void;
  options: DropdownOption[];
  ariaLabel?: string;
  disabled?: boolean;
  /** Blocks form submission while the value is empty, as a native required select does. */
  required?: boolean;
  /** The trigger's look; "ui-input" by default. */
  className?: string;
  id?: string;
  style?: CSSProperties;
  /** data-* attributes land on the trigger. */
  [data: `data-${string}`]: string | number | boolean | undefined;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number; minWidth: number; maxHeight: number } | null>(null);
  // A modal dialog sits in the top layer and makes the rest of the page inert, so a list opened from one renders inside it.
  const [host, setHost] = useState<Element | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const q = query.trim().toLowerCase();
  const shown = q ? options.filter(o => o.label.toLowerCase().includes(q)) : options;
  const enabled = shown.filter(o => !o.disabled);
  const optionId = (v: string) => `${listId}-${shown.findIndex(o => o.value === v)}`;
  const current = options.find(o => o.value === value);
  const close = (focus = true) => { setOpen(false); setQuery(""); setPlace(null); if (focus) trigger.current?.focus(); };
  const choose = (v: string) => { if (v !== value) onChange(v); close(); };
  const openList = () => {
    if (disabled) return;
    setActive(current && !current.disabled ? value : enabled[0]?.value ?? null);
    setHost(trigger.current?.closest?.("dialog[open]") ?? null);
    setOpen(true);
  };
  // Below the trigger, or above it when the room below is too small; re-measured while open.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const rect = trigger.current?.getBoundingClientRect?.();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - 12, above = rect.top - 12;
      const up = below < 240 && above > below;
      setPlace({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 8 - Math.max(rect.width, 160))), minWidth: rect.width,
        maxHeight: Math.min(520, up ? above : below), ...(up ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }) });
    };
    measure();
    const onScroll = (event: Event) => { if (!pop.current?.contains(event.target as Node)) close(false); };
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!pop.current?.contains(target) && !trigger.current?.contains(target)) close(false);
    };
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", onScroll, true);
    document.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("resize", measure); window.removeEventListener("scroll", onScroll, true); document.removeEventListener("mousedown", onDown); };
  }, [open]);
  useEffect(() => {
    if (open && active) document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
  });
  // The list is hidden until it is placed, so the search field takes focus only then.
  const placed = place !== null;
  useEffect(() => { if (open && placed) search.current?.focus(); }, [open, placed]);
  const onKeyDown = (event: KeyboardEvent) => {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) { event.preventDefault(); openList(); }
      return;
    }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === "Tab") { close(false); return; }
    if (event.key === "Enter") { event.preventDefault(); if (active) choose(active); return; }
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!step || !enabled.length) return;
    event.preventDefault();
    const index = enabled.findIndex(o => o.value === active);
    setActive(enabled[index < 0 ? 0 : (index + step + enabled.length) % enabled.length]!.value);
  };
  return <>
    <button {...data} ref={trigger} type="button" id={id} className={`ui-dropdown ${className}`} style={style} disabled={disabled}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} aria-label={ariaLabel}
      onClick={() => open ? close() : openList()} onKeyDown={onKeyDown}>
      {/* As wide as the longest option, as a native select is: hidden sizers share the value's grid cell.
          Their text is generated by CSS, so it stays out of the accessible name and textContent. */}
      <span className="ui-dropdown-box">
        <span className={`ui-dropdown-value${current && !current.disabled ? "" : " is-empty"}`}>{current?.label ?? value}</span>
        {options.map(o => <span key={o.value} className="ui-dropdown-sizer" data-label={o.label} aria-hidden="true" />)}
      </span>
      <span className="ui-dropdown-caret" aria-hidden="true">&#9662;</span>
    </button>
    {required && <input className="ui-dropdown-required" tabIndex={-1} aria-hidden="true" required value={value} onChange={() => {}}
      onFocus={() => trigger.current?.focus()} />}
    {open && createPortal(
      <div ref={pop} className="ui-picker-pop ui-dropdown-pop" onKeyDown={onKeyDown}
        style={place ? { left: place.left, top: place.top, bottom: place.bottom, minWidth: place.minWidth } : { visibility: "hidden" }}>
        {options.length > 8 && <input ref={search} className="ui-input ui-picker-search" value={query} placeholder={t("Search…", "Szukaj…")}
          aria-label={t("Filter the list", "Filtruj listę")} aria-controls={listId} aria-activedescendant={active ? optionId(active) : undefined}
          onChange={event => {
            // The first match becomes active, so typing and Enter pick it.
            const next = event.target.value.trim().toLowerCase();
            setQuery(event.target.value);
            setActive(options.find(o => !o.disabled && o.label.toLowerCase().includes(next))?.value ?? null);
          }} />}
        <ul role="listbox" id={listId} aria-label={ariaLabel} className="ui-picker-list" style={place ? { maxHeight: place.maxHeight - (options.length > 8 ? 48 : 12) } : undefined}>
          {shown.map(o => <li key={o.value} id={optionId(o.value)} role="option" data-value={o.value} aria-selected={o.value === value} aria-disabled={o.disabled || undefined}
            className={`ui-picker-option is-root${o.value === active ? " is-active" : ""}${o.disabled ? " is-disabled" : ""}`}
            onMouseEnter={() => { if (!o.disabled) setActive(o.value); }} onMouseDown={event => event.preventDefault()}
            onClick={() => { if (!o.disabled) choose(o.value); }}>
            <span className="ui-picker-title">{o.label}</span>
            <span className="ui-picker-check" aria-hidden="true">{o.value === value ? "✓" : ""}</span>
          </li>)}
          {!shown.length && <li role="presentation" className="ui-picker-empty">{t("Nothing matches", "Brak pasujących")}</li>}
        </ul>
      </div>, host ?? document.body)}
  </>;
}
/** Caps caption in front of a control, e.g. PERIOD [selector]. */
export function Field({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div className="ui-field" title={title}>
      <span className="mono ui-field-label">{label}</span>
      {children}
    </div>
  );
}
export function Disclosure({ open, onToggle, controls, children }: { open: boolean; onToggle: () => void; controls?: string; children: ReactNode }) {
  return (
    <button type="button" className="ui-disclosure" aria-expanded={open} aria-controls={controls} onClick={onToggle}>
      {open ? "▾" : "▸"} {children}
    </button>
  );
}
/** Numeric stepper; the middle field stays editable for values between the steps. */
export function Stepper({
  value,
  onChange,
  onStep,
  onBlur,
  ariaLabel,
  min,
  max,
}: {
  value: string;
  onChange: (raw: string) => void;
  onStep: (delta: number) => void;
  onBlur?: () => void;
  ariaLabel: string;
  min?: number;
  max?: number;
}) {
  return (
    <div className="ui-stepper">
      <button type="button" aria-label={`${ariaLabel} −1`} onClick={() => onStep(-1)}>−</button>
      <input type="number" aria-label={ariaLabel} min={min} max={max} step="any" value={value} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} />
      <button type="button" aria-label={`${ariaLabel} +1`} onClick={() => onStep(1)}>+</button>
    </div>
  );
}
/**
 * Explanation behind a "?" dot. Text stays in the DOM (hidden) so screen
 * readers reach it through aria-describedby; it opens on hover or focus.
 */
export function HelpDot({ label, children }: { label?: string; children?: ReactNode }) {
  const { t } = useI18n();
  const id = useId();
  const dot = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!position || !dot.current || !pop.current) return;
    const rect = dot.current.getBoundingClientRect();
    const height = pop.current.offsetHeight;
    // Flip above the dot when the explanation would run off the bottom edge.
    if (position.top + height > window.innerHeight - 8 && rect.top - 8 - height >= 8) setPosition({ left: position.left, top: rect.top - 8 - height });
  }, [position]);
  if (children == null || children === false || (typeof children === "string" && !children.trim())) return null;
  const show = () => {
    const rect = dot.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(352, window.innerWidth - 16);
    setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 12)), top: rect.bottom + 8 });
  };
  const hide = () => setPosition(null);
  const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
  return (
    <span className="ui-help">
      <button ref={dot} type="button" className="ui-help-dot" aria-label={label ?? t("More information", "Więcej informacji")} aria-describedby={id} aria-expanded={!!position}
        onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} onKeyDown={onKeyDown}>?</button>
      <span ref={pop} id={id} role="tooltip" className="ui-help-pop" hidden={!position} style={position ?? undefined}>{children}</span>
    </span>
  );
}
/** One paragraph inside a HelpDot explanation. */
export function HelpBlock({ children }: { children: ReactNode }) {
  return <span className="ui-help-block">{children}</span>;
}
export function TextInput({
  value,
  onChange,
  placeholder,
  width = 130,
  align = "left",
  title,
  disabled,
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  width?: number | string;
  align?: "left" | "right";
  title?: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      title={title}
      disabled={disabled}
      className={`ui-input${invalid ? " is-invalid" : ""}`}
      style={{ width, textAlign: align }}
    />
  );
}
export function Tabs<V extends string>({
  value,
  onChange,
  options,
  tablist,
  variant = tablist ? "sections" : "switch",
}: {
  value: V;
  onChange: (v: V) => void;
  /** `groupStart`: a short rule before this tab sets it apart from the tabs before it. */
  options: { value: V; label: string; badge?: string | number; title?: string; disabled?: boolean; groupStart?: boolean }[];
  /** Renders ARIA tabs (arrow/Home/End keys) that control one panel instead of pressed buttons. */
  tablist?: { label: string; idBase: string; panelId: string };
  /**
   * "sections" switches what the area below shows: labels on one rule, the chosen one underlined.
   * "switch" picks a value for the same content (unit, range, order): pressed buttons. ARIA tabs are sections.
   */
  variant?: "sections" | "switch";
}) {
  const tabId = (v: V) => `${tablist?.idBase}-${v}`;
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const last = options.length - 1;
    const target = event.key === "Home" ? 0 : event.key === "End" ? last : event.key === "ArrowRight" ? (index + 1) % options.length : event.key === "ArrowLeft" ? (index + last) % options.length : -1;
    if (target < 0 || options[target]!.disabled) return;
    event.preventDefault();
    onChange(options[target]!.value);
    document.getElementById(tabId(options[target]!.value))?.focus();
  };
  return (
    <div className="ui-tabs" data-variant={variant} role={tablist ? "tablist" : undefined} aria-label={tablist?.label}>
      {options.map((o, index) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className="mono ui-tab"
            data-group-start={o.groupStart || undefined}
            title={o.title}
            disabled={o.disabled}
            {...(tablist
              ? { role: "tab", id: tabId(o.value), "aria-controls": tablist.panelId, "aria-selected": on, tabIndex: on ? 0 : -1, onKeyDown: (event: KeyboardEvent) => onKeyDown(event, index) }
              : { "aria-pressed": on })}
          >
            {o.label}
            {o.badge !== undefined && o.badge !== "" && <span className="ui-tab-badge">({o.badge})</span>}
          </button>
        );
      })}
    </div>
  );
}
/** Mini switch beside an on/off chart legend: hides every series once all are shown, otherwise shows them all. */
export function LegendAllToggle({ allShown, onShowAll, onHideAll }: { allShown: boolean; onShowAll: () => void; onHideAll: () => void }) {
  const { t } = useI18n();
  return <button type="button" className="ui-legend-all" onClick={allShown ? onHideAll : onShowAll}>
    {allShown ? t("hide all", "odznacz wszystkie") : t("show all", "zaznacz wszystkie")}
  </button>;
}
/** On/off filters of one kind (event types, series): checks in one row, the all/none switch first behind a rule. */
export function CheckGroup<V extends string>({ label, title, options, value, onChange, id }: {
  label: string;
  title?: string;
  options: readonly { value: V; label: string; title?: string }[];
  value: readonly V[];
  onChange: (value: V[]) => void;
  id?: string;
}) {
  return <div id={id} className="ui-checks" role="group" aria-label={label} title={title}>
    {options.length > 1 && <LegendAllToggle allShown={options.every(option => value.includes(option.value))}
      onShowAll={() => onChange(options.map(option => option.value))} onHideAll={() => onChange([])} />}
    {options.map(option => <label key={option.value} className="ui-check" title={option.title}>
      <input type="checkbox" checked={value.includes(option.value)} onChange={event => onChange(event.target.checked
        ? options.filter(item => item.value === option.value || value.includes(item.value)).map(item => item.value)
        : value.filter(current => current !== option.value))} />{option.label}
    </label>)}
  </div>;
}
export function GhostButton({
  children,
  onClick,
  title,
  disabled,
  type = "button",
  emphasis = false,
  "aria-expanded": expanded,
  "aria-controls": controls,
}: {
  children: ReactNode;
  onClick?: () => void;
  title?: string;
  disabled?: boolean;
  type?: "button" | "submit";
  emphasis?: boolean;
  "aria-expanded"?: boolean;
  "aria-controls"?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      title={title}
      disabled={disabled}
      aria-expanded={expanded}
      aria-controls={controls}
      className={emphasis ? "ui-button is-primary" : "ui-button"}
    >
      {children}
    </button>
  );
}
export function Skeleton({ height = 14, width = "100%" }: { height?: number | string; width?: number | string }) {
  return <div className="skeleton" style={{ height, width }} />;
}
/**
 * A panel still loading: a quiet status line over a placeholder shaped like the coming content
 * (`shape`), at about the height of the panel it stands in for.
 */
export function LoadingCard({ label = "Wczytywanie...", height = 160, shape = "lines" }: { label?: string; height?: number; shape?: LoadingShape }) {
  const { t } = useI18n();
  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: "var(--s-6)", minHeight: height }}>
      <LoadingStatus key={label} label={label === "Wczytywanie..." ? t("Loading…", "Wczytywanie…") : label} />
      <LoadingSkeleton shape={shape} height={height} />
    </Card>
  );
}
export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="ui-empty">
      <div className="ui-empty-title">{title}</div>
      {detail && <div className="ui-empty-detail">{detail}</div>}
      {action}
    </div>
  );
}
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useI18n();
  return (
    <div className="ui-error">
      <span className="ui-error-mark">&#9888;</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="ui-error-title">{t("Could not load data", "Nie udało się pobrać danych")}</div>
        <div className="ui-error-detail">{message}</div>
      </div>
      {onRetry && <GhostButton onClick={onRetry}>{t("Retry", "Ponów")}</GhostButton>}
    </div>
  );
}
/** A row of labelled facts between dashed rules (paper-atlas §7): a short label, a clear value, and under it what it rests on. */
export function Facts({ children }: { children: ReactNode }) {
  return <dl className="ui-facts">{children}</dl>;
}
export function Fact({ id, label, value, notes, tone }: { id?: string; label: ReactNode; value: ReactNode; notes?: ReactNode; tone?: "warn" | "crit" }) {
  return (
    <div className={`ui-fact${tone ? ` is-${tone}` : ""}`} data-fact={id}>
      <dt>{label}</dt>
      <dd className="ui-fact-value">{value}</dd>
      {notes}
    </div>
  );
}
/** One line under a fact's value. */
export function FactNote({ children }: { children: ReactNode }) {
  return <dd className="ui-fact-note">{children}</dd>;
}
export interface DetailTab { key: string; label: ReactNode; badge?: number | string; render: () => ReactNode }
/**
 * One tab switcher instead of stacked folds (paper-atlas §7): groups of tabs, each group named when there are several,
 * and always one open panel under them. `active` falls back to the first tab.
 */
export function DetailTabs({ groups, active, onChange, label, panelRef }: {
  groups: Array<{ label?: ReactNode; tabs: DetailTab[] }>;
  active: string | null;
  onChange: (key: string) => void;
  label: string;
  panelRef?: Ref<HTMLDivElement>;
}) {
  const id = useId();
  const shown = groups.filter((group) => group.tabs.length > 0);
  const tabs = shown.flatMap((group) => group.tabs);
  const current = tabs.find((tab) => tab.key === active) ?? tabs[0];
  if (!current) return null;
  const named = shown.length > 1;
  return <div className="ui-detail-tabs" ref={panelRef}>
    <div className="ui-tabs" data-variant="sections" role="tablist" aria-label={label}>
      {shown.map((group, index) => <Fragment key={index}>
        {named && group.label && <span className={`ui-detail-group${index > 0 ? " is-split" : ""}`}>{group.label}</span>}
        {group.tabs.map((tab) => <button key={tab.key} type="button" role="tab" className="mono ui-tab" id={`${id}-${tab.key}`} aria-controls={`${id}-panel`}
          aria-selected={tab.key === current.key} data-detail-tab={tab.key} onClick={() => onChange(tab.key)}>
          {tab.label}{tab.badge != null && <span className="ui-tab-badge">{tab.badge}</span>}
        </button>)}
      </Fragment>)}
    </div>
    <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${current.key}`} data-detail={current.key}>{current.render()}</div>
  </div>;
}
