import { DataTable, TableRow } from "./ui";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { useI18n } from "../lib/i18n";
import "./CodexColumnsDrawer.css";
import "./SubscriptionRailSettings.css";

export type RailSettingsGroup = {
  key: string;
  label: string;
  accounts: { key: string; label: string; source: string; active: boolean; plan: string | null }[];
};

export function SubscriptionRailSettings({ groups, move, onClose, hidden, toggleHidden }: {
  groups: RailSettingsGroup[];
  move: (keys: string[], index: number, delta: number) => void;
  onClose: () => void;
  hidden: string[];
  toggleHidden: (key: string) => void;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const dragging = useRef<{ key: string; keys: string[] } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dropProps = (key: string) => ({
    onDragOver: (event: DragEvent) => {
      if (!dragging.current?.keys.includes(key)) return;
      event.preventDefault(); event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      setDropTarget(key);
    },
    onDrop: (event: DragEvent) => {
      const drag = dragging.current;
      if (!drag?.keys.includes(key)) return;
      event.preventDefault(); event.stopPropagation();
      move(drag.keys, drag.keys.indexOf(drag.key), drag.keys.indexOf(key) - drag.keys.indexOf(drag.key));
      dragging.current = null; setDropTarget(null);
    },
  });
  const handle = (key: string, keys: string[], label: string) => <button type="button" draggable
    data-drag-handle={key} aria-label={`${t("Drag", "Przeciągnij")}: ${label}`}
    title={t("Drag to reorder; use the arrows for keyboard control", "Przeciągnij, aby zmienić kolejność; klawiaturą użyj strzałek")}
    className="codex-column-option__handle"
    onDragStart={event => { dragging.current = { key, keys }; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", key); }}
    onDragEnd={() => { dragging.current = null; setDropTarget(null); }}>⠿</button>;
  const visibility = (key: string, label: string) => <input type="checkbox" checked={!hidden.includes(key)}
    data-visibility={key} aria-label={`${t("Show", "Pokaż")}: ${label}`}
    onChange={() => toggleHidden(key)} title={t("Show in subscription rail", "Pokaż w kolumnie subskrypcji")} />;
  useEffect(() => {
    const node = dialog.current!;
    node.showModal();
    return () => node.close();
  }, []);
  const controls = (keys: string[], index: number, label: string) => <span style={{ display: "flex", gap: 6 }}>
    {[-1, 1].map(delta => <button type="button" key={delta}
      disabled={index + delta < 0 || index + delta >= keys.length}
      aria-label={`${delta < 0 ? t("Move up", "Przesuń w górę") : t("Move down", "Przesuń w dół")}: ${label}`}
      onClick={() => move(keys, index, delta)} className="codex-column-option__handle">
      {delta < 0 ? "↑" : "↓"}
    </button>)}
  </span>;
  return <dialog ref={dialog} className="codex-columns-drawer subscription-rail-settings"
    aria-labelledby="rail-settings-title" onCancel={onClose} onClick={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    <header className="codex-columns-drawer__header">
      <h2 id="rail-settings-title">{t("Subscription settings", "Ustawienia subskrypcji")}</h2>
      <button type="button" onClick={onClose} aria-label={t("Close subscription settings", "Zamknij ustawienia subskrypcji")}>✕</button>
    </header>
    <div className="codex-columns-drawer__body">
      <p>{t("Drag the handles or use the arrows to reorder. Uncheck to hide a provider or account from the rail; totals stay unchanged. Changes are saved in this browser. × is relative to the provider's base plan; ×? means the variant is unknown.", "Przeciągaj uchwyty lub używaj strzałek. Odznacz dostawcę lub konto, aby ukryć je w kolumnie; sumy pozostają bez zmian. Zmiany zapisują się w tej przeglądarce. × oznacza mnożnik względem bazowego planu dostawcy; ×? — nieznany wariant.")}</p>
      <div className="subscription-rail-settings__scroll">
      <DataTable tableId="SubscriptionRailSettings:0" className="subscription-rail-settings__table" aria-label={t("Subscriptions visibility and order", "Widoczność i kolejność subskrypcji")}>
        <thead><TableRow header>
          <th data-column-id="c0" scope="col" aria-label={t("Drag", "Przeciągnij")}></th>
          <th data-column-id="c1" scope="col">{t("Show", "Pokaż")}</th>
          <th data-column-id="c2" scope="col">{t("Account", "Konto")}</th>
          <th data-column-id="c3" scope="col">{t("Plan", "Plan")}</th>
          <th data-column-id="c4" scope="col">{t("Source", "Źródło")}</th>
          <th data-column-id="c5" scope="col">{t("Order", "Kolejność")}</th>
        </TableRow></thead>
      {groups.map((group, groupIndex) => <tbody key={group.key}>
        <TableRow {...dropProps(group.key)} data-drop-row={group.key} data-drop-target={dropTarget === group.key || undefined} className="subscription-rail-settings__provider">
          <td>{handle(group.key, groups.map(item => item.key), group.label)}</td>
          <td>{visibility(group.key, group.label)}</td>
          <th scope="rowgroup" colSpan={3}>{group.label}</th>
          <td>{controls(groups.map(item => item.key), groupIndex, group.label)}</td>
        </TableRow>
        {group.accounts.map(account => {
          const peers = group.accounts.filter(item => item.active === account.active);
          return <TableRow key={account.key} {...dropProps(account.key)} data-drop-row={account.key} data-drop-target={dropTarget === account.key || undefined}>
            <td>{handle(account.key, peers.map(item => item.key), account.label)}</td>
            <td>{visibility(account.key, account.label)}</td>
            <th scope="row" className="mono">{account.label}{!account.active && <span className="subscription-rail-settings__archived"> · {t("Archived", "Archiwalne")}</span>}</th>
            <td className="mono">{account.plan ?? "—"}</td>
            <td className="mono subscription-rail-settings__source" title={account.source}>{account.source}</td>
            <td>{controls(peers.map(item => item.key), peers.findIndex(item => item.key === account.key), account.label)}</td>
          </TableRow>;
        })}
      </tbody>)}
      </DataTable>
      </div>
    </div>
  </dialog>;
}
