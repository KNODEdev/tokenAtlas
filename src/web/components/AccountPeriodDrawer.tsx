import { useEffect, useId, useRef, type ReactNode } from "react";
import { useI18n } from "../lib/i18n";
import "./CodexColumnsDrawer.css";

/** Uses the application's native modal drawer: focus trap, Escape and focus restoration. */
export function AccountPeriodDrawer({ title, subtitle, busy, onClose, children, returnFocus, className, closeLabel }: {
  title: string; subtitle: string; busy: boolean; onClose: () => void; children: ReactNode; returnFocus: Pick<HTMLElement, "focus"> | null;
  className?: string; closeLabel?: string;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current!;
    const previous = returnFocus;
    node.showModal();
    return () => { node.close(); previous?.focus(); };
  }, []);
  return <dialog ref={dialog} className={["codex-columns-drawer account-period-drawer", className].filter(Boolean).join(" ")} aria-labelledby={titleId}
    onCancel={(event) => {
      // React bubbles a nested editor's cancel through its parent drawer; only its own Escape closes this one.
      if (event.target !== event.currentTarget) return;
      event.preventDefault(); if (!busy) onClose();
    }}
    onClick={(event) => {
      if (busy || event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    <header className="codex-columns-drawer__header">
      <div><h2 id={titleId}>{title}</h2><p>{subtitle}</p></div>
      <button type="button" disabled={busy} onClick={onClose} aria-label={closeLabel ?? t("Close period editor", "Zamknij edycję okresu")}>✕</button>
    </header>
    <div className="codex-columns-drawer__body">{children}</div>
  </dialog>;
}
