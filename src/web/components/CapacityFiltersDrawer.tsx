import { useEffect, useId, useRef, type ReactNode } from "react";
import { useI18n } from "../lib/i18n";
import "./CodexColumnsDrawer.css";

/** Reset is shown only when the parent can clear the filters; it stays disabled while nothing is active. */
export function CapacityFiltersDrawer({ children, onClose, onReset, activeCount, id }: {
  children: ReactNode; onClose: () => void; onReset?: () => void; activeCount?: number; id: string;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current!;
    node.showModal();
    return () => node.close();
  }, []);
  return <dialog ref={dialog} id={id} className="codex-columns-drawer stats-filters-drawer" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    <header className="codex-columns-drawer__header">
      <h2 id={titleId}>{t("Advanced filters", "Zaawansowane filtry")}</h2>
      <button type="button" onClick={onClose} aria-label={t("Close advanced filters", "Zamknij zaawansowane filtry")}>✕</button>
    </header>
    <div className="codex-columns-drawer__body stats-filters-body">{children}</div>
    <footer className="stats-filters-footer">
      {onReset && <button type="button" className="ui-button" onClick={onReset} disabled={activeCount === 0}>
        {t("Reset filters", "Resetuj filtry")}
      </button>}
      <button type="button" className="ui-button is-primary" onClick={onClose}>{t("Done", "Gotowe")}</button>
    </footer>
  </dialog>;
}
