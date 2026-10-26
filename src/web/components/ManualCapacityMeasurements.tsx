import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ManualCapacityInput, ManualCapacityMeasurement, ManualCapacityStore } from "../../shared/manual-capacity";
import { manualCapacityCounters, parseCapacityCounter } from "../../shared/manual-capacity";
import type { CodexComparisonWindow } from "../../shared/codex-accounting";
import { api, ApiError, bustApiMemo } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useI18n } from "../lib/i18n";
import { ErrorState, Field, GhostButton, Selector } from "./ui";
import "./ManualCapacityMeasurements.css";

export type ManualCapacityProps = {
  provider: string; account: string; counter?: string | null;
  counters?: Array<{ id: string; label: string }>; windows: CodexComparisonWindow[];
  onSaved: (counter: string, increase?: number, range?: { since: string; until: string }) => void;
};

function localInput(iso: string): string {
  const ms = Date.parse(iso);
  return new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 23);
}

/** A 409 means the stored readings changed (another tab, or an overlapping period): say so and reload them. */
export function manualSaveError(error: unknown, t: (en: string, pl: string) => string): string {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof ApiError && error.status === 409
    ? `${t("Not saved: the stored readings changed or overlap this period. The list was refreshed; check it and try again.", "Nie zapisano: zapisane pomiary zmieniły się albo nakładają na ten okres. Lista została odświeżona; sprawdź ją i spróbuj ponownie.")} (${message})`
    : message;
}

/** Removes one manual reading against the latest stored revision. */
export async function removeManualReading(provider: string, account: string, id: string): Promise<ManualCapacityStore> {
  // A save elsewhere may have changed the revision since this view read it.
  bustApiMemo();
  const store = await api.manualCapacity(provider, account);
  return api.saveManualCapacity(provider, account, { revision: store.revision, remove: id });
}

type Draft = { id?: string; counter: string; start: string; end: string; startPercent: string; endPercent: string; approximate: boolean; note: string };

/** Add or edit one manual reading; `initialId` opens that reading, `onClose` shows a close button. */
export function MeasurementEditor(props: ManualCapacityProps & { initialId?: string | null; onClose?: () => void }) {
  const { t, locale } = useI18n();
  const state = useAsync(() => api.manualCapacity(props.provider, props.account), [props.provider, props.account]);
  const [savedStore, setSavedStore] = useState<ManualCapacityStore | null>(null);
  const store = savedStore ?? state.data;
  const counters = [...new Map([...manualCapacityCounters(props.provider), ...(props.counters ?? []),
    ...(store?.measurements ?? []).map(m => ({ id: m.counter, label: parseCapacityCounter(m.counter)?.join(" · ") ?? m.counter }))].map(c => [c.id, c])).values()];
  const fresh = (): Draft => ({ counter: props.counter ?? counters[0]!.id, start: "", end: "",
    startPercent: "", endPercent: "", approximate: false, note: "" });
  const [draft, setDraft] = useState<Draft>(fresh);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [saved, setSaved] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const patch = (value: Partial<Draft>) => { setDraft(old => ({ ...old, ...value })); setSaved(false); };
  const edit = (m: ManualCapacityMeasurement) => {
    setDraft({ id: m.id, counter: m.counter, start: localInput(m.start), end: localInput(m.end), startPercent: String(m.start_percent),
      endPercent: String(m.end_percent), approximate: m.approximate_time, note: m.note });
    setSaved(false); setError(null); setConfirmRemove(false);
  };
  // Open the requested reading once the stored list has loaded.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !store || !props.initialId) return;
    opened.current = true;
    const m = store.measurements.find(item => item.id === props.initialId);
    if (m) edit(m);
  }, [store, props.initialId]);
  const failed = (e: unknown) => { setError(manualSaveError(e, t)); setSavedStore(null); bustApiMemo(); state.reload(); };
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!store || busy) return;
    setError(null); setSaved(false);
    const start = Date.parse(draft.start), end = Date.parse(draft.end), startPercent = Number(draft.startPercent), endPercent = Number(draft.endPercent);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end > Date.now() || !draft.startPercent.trim() || !draft.endPercent.trim()
      || !Number.isFinite(startPercent) || !Number.isFinite(endPercent) || startPercent < 0 || endPercent > 100 || endPercent <= startPercent) {
      setError(t("Enter a past interval and an increasing percentage from 0 to 100.", "Podaj miniony okres oraz rosnący procent od 0 do 100.")); return;
    }
    const measurement: ManualCapacityInput = { id: draft.id, counter: draft.counter, start: new Date(start).toISOString(), end: new Date(end).toISOString(),
      start_percent: startPercent, end_percent: endPercent, approximate_time: draft.approximate, note: draft.note };
    setBusy(true);
    try {
      const next = await api.saveManualCapacity(props.provider, props.account, { revision: store.revision, measurement });
      setSavedStore(next);
      const entry = next.measurements.find(m => m.id === draft.id) ?? next.measurements.at(-1);
      if (entry) edit(entry);
      setSaved(true); props.onSaved(draft.counter, endPercent - startPercent, { since: measurement.start.slice(0, 10), until: measurement.end.slice(0, 10) });
    } catch (e) { failed(e); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!store || !draft.id || busy) return;
    setBusy(true); setError(null); setSaved(false); setConfirmRemove(false);
    try {
      setSavedStore(await api.saveManualCapacity(props.provider, props.account, { revision: store.revision, remove: draft.id }));
      setDraft(fresh()); props.onSaved("");
    } catch (e) { failed(e); }
    finally { setBusy(false); }
  }
  const windows = props.windows.filter(w => !w.manual_measurement);
  return <div className="manual-editor">
    <div className="manual-editor-head">
      <b>{draft.id ? t("Edit manual reading", "Edycja ręcznego pomiaru") : t("New manual reading", "Nowy ręczny pomiar")}</b>
      <span className="manual-editor-sub">{t("Readings of one account counter within one cycle, with no reset between them. Times use your local time zone. A manual interval replaces overlapping automatic estimates; original readings are preserved.",
        "Odczyty jednego licznika konta w obrębie jednego cyklu, bez resetu między nimi. Daty są w Twojej strefie czasowej. Ręczny przedział zastępuje nakładające się szacunki automatyczne; oryginalne odczyty zostają zachowane.")}</span>
      {props.onClose && <GhostButton onClick={props.onClose}>{t("Close", "Zamknij")}</GhostButton>}
    </div>
    {state.error && <ErrorState message={state.error} onRetry={state.reload} />}
    {!store && !state.error && <p role="status" className="manual-editor-sub">{t("Loading readings…", "Wczytywanie pomiarów…")}</p>}
    {store && <form onSubmit={save}>
      <fieldset disabled={busy} className="manual-editor-fields">
        <div className="ui-toolbar">
          <Field label={t("Reading", "Pomiar")}>
            <Selector ariaLabel={t("Edit manual reading", "Edytuj ręczny pomiar")} value={draft.id ?? ""} onChange={value => {
              const m = store.measurements.find(item => item.id === value); if (m) edit(m); else { setDraft(fresh()); setSaved(false); setError(null); setConfirmRemove(false); }
            }} options={[{ value: "", label: t("New reading", "Nowy pomiar") }, ...store.measurements.map(m => ({ value: m.id,
              label: `${new Date(m.start).toLocaleString(locale)} – ${new Date(m.end).toLocaleString(locale)} · ${m.start_percent}% → ${m.end_percent}%` }))]} />
          </Field>
          {!!windows.length && <Field label={t("Fill from cycle", "Wypełnij z cyklu")}>
            <Selector ariaLabel={t("Use cycle dates", "Użyj dat cyklu")} value="" onChange={value => {
              const w = windows.find(item => item.id === value); if (w) patch({ start: localInput(w.start), end: localInput(w.end), startPercent: String(w.start_percent), endPercent: String(w.end_percent) });
            }} options={[{ value: "", label: "—" }, ...windows.map(w => ({ value: w.id, label: `${w.start.slice(0, 10)} – ${w.end.slice(0, 10)} · ${w.observed_pp}%` }))]} />
          </Field>}
        </div>
        <div className="manual-editor-grid">
          <Field label={t("Counter", "Licznik")}>
            <Selector ariaLabel={t("Manual reading counter", "Licznik ręcznego pomiaru")} value={draft.counter} onChange={value => patch({ counter: value })} options={counters.map(c => ({ value: c.id, label: c.label }))} />
          </Field>
          <Field label={t("From", "Od")}><input className="ui-date-input" aria-label={t("Reading start", "Początek pomiaru")} type="datetime-local" step="0.001" required value={draft.start} onChange={e => patch({ start: e.target.value })} /></Field>
          <Field label={t("To", "Do")}><input className="ui-date-input" aria-label={t("Reading end", "Koniec pomiaru")} type="datetime-local" step="0.001" required value={draft.end} onChange={e => patch({ end: e.target.value })} /></Field>
          <Field label={t("Start %", "% początkowy")}><input className="ui-date-input manual-editor-percent" aria-label={t("Start percentage", "Procent początkowy")} type="number" min="0" max="100" step="any" required value={draft.startPercent} onChange={e => patch({ startPercent: e.target.value })} /></Field>
          <Field label={t("End %", "% końcowy")}><input className="ui-date-input manual-editor-percent" aria-label={t("End percentage", "Procent końcowy")} type="number" min="0" max="100" step="any" required value={draft.endPercent} onChange={e => patch({ endPercent: e.target.value })} /></Field>
          <Field label={t("Note", "Notatka")}><input className="ui-date-input manual-editor-note" aria-label={t("Reading note", "Notatka do pomiaru")} maxLength={1000} value={draft.note} onChange={e => patch({ note: e.target.value })} /></Field>
        </div>
        {props.provider === "gemini" && <label className="manual-editor-sub"><input type="checkbox" checked={draft.approximate} onChange={e => patch({ approximate: e.target.checked })} /> {t("Include approximate conversation/file dates. The result will be an approximation.", "Uwzględnij przybliżone daty rozmów/plików. Wynik będzie przybliżeniem.")}</label>}
        <div className="ui-toolbar">
          <GhostButton type="submit" emphasis disabled={busy}>{busy ? t("Saving…", "Zapisywanie…") : t("Save reading", "Zapisz pomiar")}</GhostButton>
          {draft.id && !confirmRemove && <GhostButton disabled={busy} onClick={() => setConfirmRemove(true)}>{t("Remove manual reading", "Usuń ręczny pomiar")}</GhostButton>}
          {draft.id && confirmRemove && <span className="manual-confirm" role="group" aria-label={t("Confirm removal", "Potwierdź usunięcie")}>
            {t("Remove this reading? Automatic estimates return for its period.", "Usunąć ten pomiar? Dla tego okresu wrócą szacunki automatyczne.")}
            <button type="button" className="manual-danger" onClick={remove}>{t("Yes, remove", "Tak, usuń")}</button>
            <button type="button" className="ui-link-button" onClick={() => setConfirmRemove(false)}>{t("Cancel", "Anuluj")}</button>
          </span>}
          {saved && <span role="status" className="manual-editor-sub">{t("Reading saved. Recalculating capacity.", "Pomiar zapisany. Przeliczam pojemność.")}</span>}
        </div>
      </fieldset>
    </form>}
    {error && <p role="alert" className="ui-alert">{error}</p>}
  </div>;
}

export function ManualCapacityMeasurements(props: ManualCapacityProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return <section aria-label={t("Manual percentage readings", "Ręczne pomiary procentowe")}>
    <GhostButton aria-expanded={open} onClick={() => setOpen(value => !value)}>{t("Enter / edit %", "Uzupełnij / edytuj %")}</GhostButton>
    {open && <MeasurementEditor {...props} key={`${props.provider}:${props.account}`} />}
  </section>;
}
