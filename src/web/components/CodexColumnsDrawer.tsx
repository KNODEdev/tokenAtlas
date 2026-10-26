import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
import "./CodexColumnsDrawer.css";

export function CodexColumnsDrawer({ columns, selected, onChange, onClose, onReset, saveError }: {
  columns: ReadonlyArray<{ id: string; label: string }>;
  selected: string[];
  onChange: (ids: string[]) => void;
  onClose: () => void;
  onReset?: () => void;
  saveError?: boolean;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const dragging = useRef<{ id: string; x: number; y: number } | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    const node = dialog.current!;
    node.showModal();
    return () => node.close();
  }, []);
  const groups = [
    { label: t("Active", "Aktywne"), active: true, ids: selected },
    { label: t("Inactive", "Nieaktywne"), active: false, ids: columns.filter(c => !selected.includes(c.id)).map(c => c.id) },
  ];
  function move(id: string, to: string) {
    if (id === to || !selected.includes(id) || !selected.includes(to)) return;
    const next = selected.filter(c => c !== id);
    next.splice(selected.indexOf(to), 0, id);
    onChange(next);
  }
  function transfer(id: string, active: boolean, before?: string) {
    if (!columns.some(c => c.id === id)) return;
    if (!active) {
      if (selected.includes(id) && selected.length > 1) onChange(selected.filter(c => c !== id));
      return;
    }
    if (id === before) return;
    const next = selected.filter(c => c !== id);
    const index = before ? next.indexOf(before) : next.length;
    next.splice(index < 0 ? next.length : index, 0, id);
    onChange(next);
  }
  function dropAt(x: number, y: number) {
    const element = document.elementFromPoint(x, y);
    const group = element?.closest<HTMLElement>("[data-column-group]");
    if (!group || !dialog.current?.contains(group)) return null;
    const row = element?.closest<HTMLElement>("[data-column-id]");
    const active = group.dataset.columnGroup === "active";
    let before = row?.dataset.columnId;
    if (row && before && active) {
      const rect = row.getBoundingClientRect();
      if (y > rect.top + rect.height / 2) before = selected[selected.indexOf(before) + 1];
    }
    return { active, before: active ? before : undefined, highlight: row?.dataset.columnId ?? (active ? "Aktywne" : "Nieaktywne") };
  }
  return <dialog ref={dialog} className="codex-columns-drawer table-columns-drawer" aria-labelledby={titleId} onCancel={onClose}
    onClick={e => {
      if (e.target !== e.currentTarget) return;
      const rect = e.currentTarget.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) onClose();
    }}>
    <header className="codex-columns-drawer__header">
      <div><h2 id={titleId}>{t("Table columns", "Kolumny tabeli")}</h2><p>{selected.length}/{columns.length}</p></div>
      <button type="button" onClick={onClose} aria-label={t("Close column chooser", "Zamknij wybór kolumn")}>✕</button>
    </header>
    <div className="codex-columns-drawer__body">
      {saveError && <div role="alert" className="ui-alert">{t("Could not save column settings", "Nie udało się zapisać ustawień kolumn")}</div>}
      <div className="codex-columns-drawer__grid">
        {groups.map(group => <section key={group.label} aria-label={group.label} className="codex-columns-drawer__group"
          data-column-group={group.active ? "active" : "inactive"} data-drop={target === group.label || undefined}>
          <h3>{group.label} <span className="mono">{group.ids.length}</span></h3>
          <div className="codex-columns-drawer__list">
        {group.ids.map(id => {
          const column = columns.find(c => c.id === id)!;
          const enabled = selected.includes(id), position = selected.indexOf(id);
          return <div key={id} className="codex-column-option" data-column-id={id} data-drop={target === id || undefined}>
            <button type="button" className="codex-column-option__handle"
              aria-label={`${t("Move", "Przenieś")} ${column.label}`} title={t("Drag or use Alt + arrow", "Przeciągnij lub użyj Alt + strzałka")}
              onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId); dragging.current = { id, x: e.clientX, y: e.clientY }; }}
              onPointerMove={e => { if (dragging.current) setTarget(dropAt(e.clientX, e.clientY)?.highlight ?? null); }}
              onPointerUp={e => {
                const drag = dragging.current, destination = dropAt(e.clientX, e.clientY);
                dragging.current = null; setTarget(null);
                if (drag && destination && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) >= 5) transfer(drag.id, destination.active, destination.before);
              }}
              onPointerCancel={() => { dragging.current = null; setTarget(null); }}
              onKeyDown={e => {
                if (!e.altKey || !enabled) return;
                const offset = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : 0;
                const to = selected[position + offset];
                if (offset && to) { e.preventDefault(); move(id, to); }
              }}>⠿</button>
            <span className="codex-column-option__label">{enabled && <span className="mono">{position + 1}. </span>}{column.label}</span>
            <button type="button" className="codex-column-option__switch" role="switch" aria-label={column.label} aria-checked={enabled}
              disabled={enabled && selected.length === 1}
              onClick={() => transfer(id, !enabled)}><span /></button>
          </div>;
        })}
          {!group.ids.length && <p className="codex-columns-drawer__empty">{t("Drag a column here", "Przeciągnij tutaj kolumnę")}</p>}
          </div>
        </section>)}
      </div>
    </div>
    <footer className="table-columns-footer">
      {onReset && <button type="button" className="ui-button" onClick={onReset}>{t("Reset columns", "Resetuj kolumny")}</button>}
      <button type="button" className="ui-button is-primary" onClick={onClose}>{t("Done", "Gotowe")}</button>
    </footer>
  </dialog>;
}
