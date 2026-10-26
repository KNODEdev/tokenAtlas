import { useState } from "react";
import { api, type RateModel } from "../lib/api";
import { useI18n } from "../lib/i18n";
const inputStyle = { width: 70, background: "var(--surface)", color: "var(--text)", border: "1px solid var(--line2)", borderRadius: "var(--r-chip)", padding: "var(--s-1) var(--s-3)", fontFamily: "var(--font-sans)", fontSize: "var(--fs-3)" };
// Compact pencilled buttons: the editor lives inside a rate table cell.
const buttonStyle = { padding: "var(--s-1) var(--s-4)", fontSize: "var(--fs-2)" };

export function CodexSpeedEditor({ model, onSaved }: { model: RateModel; onSaved?: () => void }) {
  const { t } = useI18n();
  const speed = model.codex_speed;
  const [editing, setEditing] = useState(false);
  const [credit, setCredit] = useState("");
  const [apiRate, setApiRate] = useState("");
  const [day, setDay] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!speed) return null;
  const save = async () => {
    const c = Number(credit.replace(",", ".")), a = Number(apiRate.replace(",", "."));
    if (![c, ...(speed.api_editable ? [a] : [])].every(n => Number.isFinite(n) && n > 0 && n <= 100) || !day) {
      setError(t("Enter multipliers > 0 and ≤ 100, plus a date.", "Podaj mnożniki > 0 i ≤ 100 oraz datę.")); return;
    }
    setBusy(true); setError(null);
    try {
      await api.saveRateCard({ vendor: "openai", model: model.model,
        codex_speed: { credit_multiplier: c, ...(speed.api_editable ? { api_multiplier: a } : {}), valid_from: day } });
      setEditing(false); onSaved?.();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <div style={{ fontSize: "var(--fs-2)", color: "var(--muted)", marginTop: "var(--s-2)", whiteSpace: "normal" }}>
    <div>{t("Speed", "Speed")}: {t("limit", "limit")} ×{speed.credit_multiplier ?? "?"} · API ×{speed.api_multiplier ?? "?"}</div>
    {!editing ? <button type="button" className="ui-button" style={{ ...buttonStyle, marginTop: "var(--s-2)" }} disabled={!speed.editable}
      title={speed.editable ? t("Edit this model's Speed multipliers", "Edytuj mnożniki Speed tego modelu") : t("Standard base rates are required to calculate the multiplier", "Brak bazowych stawek Standard do wyliczenia mnożnika")}
      onClick={() => { setCredit(String(speed.credit_multiplier ?? 1)); setApiRate(String(speed.api_multiplier ?? 1));
        setDay(new Date().toISOString().slice(0, 10)); setError(null); setEditing(true); }}>{t("Configure Speed", "konfiguruj Speed")}</button>
      : <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: "var(--s-3) 0", display: "grid", gap: "var(--s-2)" }}>
        <label>{t("Limit", "Limit")} × <input style={inputStyle} aria-label={`${model.model} ${t("Speed limit multiplier", "mnożnik limitu Speed")}`} value={credit} onChange={e => setCredit(e.target.value)} /></label>
        {speed.api_editable && <label>API × <input style={inputStyle} aria-label={`${model.model} ${t("Speed API multiplier", "mnożnik API Speed")}`} value={apiRate} onChange={e => setApiRate(e.target.value)} /></label>}
        <label>{t("From UTC date", "Od dnia UTC")} <input style={{ ...inputStyle, width: 125 }} type="date" aria-label={`${model.model} ${t("Speed from date", "Speed od dnia")}`} value={day} onChange={e => setDay(e.target.value)} /></label>
        <span>{t("Applies to events from the selected date. Tokens are not multiplied.", "Dotyczy zdarzeń od wybranej daty. Tokeny pozostają bez mnożnika.")}</span>
        <span style={{ display: "inline-flex", gap: "var(--s-3)" }}><button type="button" className="ui-button" style={buttonStyle} onClick={save}>{busy ? t("Saving…", "Zapisywanie…") : t("Save Speed", "Zapisz Speed")}</button><button type="button" className="ui-button" style={buttonStyle} onClick={() => setEditing(false)}>{t("Cancel", "Anuluj")}</button></span>
        {error && <span role="alert" style={{ color: "var(--warn)" }}>{error}</span>}
      </fieldset>}
    {speed.valid_from && <div>{t("from", "od")} {speed.valid_from} · {speed.confidence === "user" ? t("custom setting", "ustawienie własne") : t("list price", "cennik")}</div>}
  </div>;
}
