import { useEffect, useRef, useState } from "react";
import type { TimelineMarker } from "../../shared/codex-accounting";
import { useI18n } from "../lib/i18n";
import { Dropdown } from "./ui";
import "./CodexColumnsDrawer.css";

// Fields fill the drawer width; the paper look comes from .ui-input.
const field = { width: "100%", marginTop: 4, padding: "6px 8px" };
export function CodexMarkerEditor({ markers, onSave, onRemove, onClose, initialDay }: {
  markers: TimelineMarker[]; onSave: (marker: TimelineMarker) => Promise<void>; onRemove: (id: string) => Promise<void>; onClose: () => void; initialDay?: string;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const defaultDay = initialDay && /^\d{4}-\d{2}-\d{2}$/.test(initialDay) ? initialDay : new Date().toISOString().slice(0, 10);
  const blank = (): TimelineMarker => ({ id: `custom:${crypto.randomUUID()}`, day: defaultDay, label: "", note: "", color: "accent", visible: true });
  const [draft, setDraft] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { const node = dialog.current!; node.showModal(); return () => node.close(); }, []);
  async function submit(remove = false) {
    setBusy(true); setError("");
    try { if (remove) await onRemove(draft.id); else await onSave(draft); onClose(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="codex-columns-drawer" aria-labelledby="codex-markers-title" onCancel={onClose}>
    <header className="codex-columns-drawer__header"><div><h2 id="codex-markers-title">{t("Timeline points", "Punkty na osi czasu")}</h2><p>{t("Custom events and automatically detected models", "Własne zdarzenia i automatycznie wykryte modele")}</p></div>
      <button type="button" onClick={onClose} aria-label={t("Close point editor", "Zamknij edycję punktów")}>✕</button></header>
    <div className="codex-columns-drawer__body">
      <label>{t("Edit point", "Edytuj punkt")} <Dropdown className="ui-input" style={field} value={markers.some(m => m.id === draft.id) ? draft.id : ""} onChange={value => { setDraft(markers.find(m => m.id === value) ?? blank()); setError(""); }} options={[
        { value: "", label: `+ ${t("New custom point", "Nowy własny punkt")}` },
        ...markers.map(m => ({ value: m.id, label: `${m.visible ? "●" : "○"} ${m.day} · ${m.label}${m.id.startsWith("model:") ? ` · ${t("detected model", "wykryty model")}` : ""}` })),
      ]} /></label>
      <form onSubmit={e => { e.preventDefault(); void submit(); }} style={{ marginTop: 18 }}>
        <fieldset disabled={busy} style={{ border: 0, padding: 0, display: "grid", gap: 14 }}>
          <label>{t("Date", "Data")} <input className="ui-input" style={field} type="date" required value={draft.day} onChange={e => setDraft({ ...draft, day: e.target.value })} /></label>
          <label>{t("Name", "Nazwa")} <input className="ui-input" style={field} required maxLength={120} value={draft.label} onChange={e => setDraft({ ...draft, label: e.target.value })} /></label>
          <label>{t("Description", "Opis")} <textarea className="ui-input" style={field} rows={4} maxLength={1000} value={draft.note} onChange={e => setDraft({ ...draft, note: e.target.value })} /></label>
          <label>{t("Color", "Kolor")} <Dropdown className="ui-input" style={field} value={draft.color} onChange={value => setDraft({ ...draft, color: value as TimelineMarker["color"] })} options={[
            { value: "accent", label: t("Accent", "Akcent") }, { value: "violet", label: t("Violet", "Fioletowy") },
            { value: "warn", label: t("Amber", "Bursztynowy") }, { value: "ok", label: t("Green", "Zielony") },
          ]} /></label>
          <label><input type="checkbox" checked={draft.visible} onChange={e => setDraft({ ...draft, visible: e.target.checked })} /> {t("Show point on chart", "Pokaż punkt na wykresie")}</label>
          {!draft.id.startsWith("custom:") && <p>{t("You can edit an automatic point. Your setting takes precedence. Clear visibility to hide it.", "Możesz edytować automatyczny punkt. Własne ustawienie ma pierwszeństwo. Odznacz widoczność, aby go ukryć.")}</p>}
          {error && <p role="alert" className="ui-alert">{error}</p>}
          <div style={{ display: "flex", gap: 10 }}><button className="ui-button" type="submit">{busy ? t("Saving…", "Zapisywanie…") : t("Save point", "Zapisz punkt")}</button>
            {draft.id.startsWith("custom:") && markers.some(m => m.id === draft.id) && <button className="ui-button" type="button" onClick={() => void submit(true)}>{t("Delete point", "Usuń punkt")}</button>}</div>
        </fieldset>
      </form>
      <p style={{ marginTop: 18, color: "var(--muted)" }}>{t("Points are saved in the tokenAtlas configuration, independently of browser storage. Detection scans the entire indexed Codex archive, including dates outside the selected range. Other new models appear in the list as hidden suggestions.", "Punkty są zapisywane w konfiguracji tokenAtlas, niezależnie od pamięci przeglądarki. Wykrywanie przegląda całe zaindeksowane archiwum Codex, również poza wybranym zakresem dat. Pozostałe nowe modele trafiają na listę jako ukryte propozycje.")}</p>
    </div>
  </dialog>;
}
