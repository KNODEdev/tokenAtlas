import { useState } from "react";
import { api, type CapacityRegime, type PlanSettingRow, type PlansCatalog } from "../lib/api";
import { CODEX_PROMOTIONS } from "../../shared/codex-promotions";
import { useI18n } from "../lib/i18n";
import { Card, CardTitle, Dropdown, HelpDot } from "./ui";
import { CodexPromotionHistory } from "./CodexPromotionHistory";
import "./CapacityPromotionsPanel.css";

export function CapacityPromotionsPanel({ rows, catalog, onSaved, initialAccount, initialRange, bare = false }: {
  rows: PlanSettingRow[]; catalog: PlansCatalog; onSaved: () => void;
  initialAccount?: string; initialRange?: { since: string; until: string };
  /** Inside a fold whose summary already names the panel: keep only the explanation dot. */
  bare?: boolean;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState(initialAccount ?? "");
  const [editing, setEditing] = useState(false);
  const row = rows.find(r => r.subscription === selected) ?? rows[0];
  const sub = t("Account-specific periods. Only confirmed, enabled terms affect estimates.", "Okresy przypisane do konta. Tylko potwierdzone, włączone warunki wpływają na szacunki.");
  return <Card pad="14px 16px">
    {bare ? <HelpDot label={t("Promotions and capacity", "Promocje i pojemność")}>{sub}</HelpDot> : <CardTitle title={t("Promotions and capacity", "Promocje i pojemność")} help={sub} />}
    {row ? <>
      {/* Settings → Accounts passes one account's subscriptions; a single one needs no picker. */}
      {rows.length > 1 && <label className="capacity-promotion-account">{t("Subscription", "Subskrypcja")} <Dropdown disabled={editing} value={row.subscription} onChange={value => setSelected(value)}
        options={rows.map(r => ({ value: r.subscription, label: `${r.subscription} · ${r.vendor}` }))} /></label>}
      <PromotionEditor key={row.subscription} row={row} catalog={catalog} onSaved={onSaved} onEditing={setEditing} initialRange={row.subscription === initialAccount ? initialRange : undefined} />
    </> : <p>{t("No subscriptions in this provider filter.", "Brak subskrypcji dla wybranego dostawcy.")}</p>}
  </Card>;
}

function PromotionEditor({ row, catalog, onSaved, onEditing, initialRange }: { row: PlanSettingRow; catalog: PlansCatalog; onSaved: () => void; onEditing: (value: boolean) => void; initialRange?: { since: string; until: string } }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<CapacityRegime[] | null>(null);
  const [base, setBase] = useState<CapacityRegime[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [modified, setModified] = useState(false);
  const regimes = draft ?? row.capacity_regimes ?? [];
  const group = catalog.provider_groups.find(g => [g.id, ...g.aliases].includes(row.vendor.toLowerCase()));
  const codex = ["codex", "openai"].includes(row.vendor.toLowerCase());
  function change(next: CapacityRegime[]) {
    if (base === null) setBase(row.capacity_regimes ?? []);
    setDraft(next); setSaved(false); setError(""); setModified(true); onEditing(true);
  }
  function patch(id: string, update: Partial<CapacityRegime>) {
    change(regimes.map(r => r.id === id ? { ...r, ...update } : r));
  }
  function add(offerId?: string) {
    const offer = CODEX_PROMOTIONS.find(p => p.id === offerId && p.kind === "allowance");
    if (offerId && !offer) return;
    change([...regimes, { id: crypto.randomUUID(), subscription: row.subscription, factor: offer?.factor ?? 1,
      from: offer?.announced ?? initialRange?.since ?? new Date().toISOString().slice(0, 10), until: offer ? offer.until : initialRange?.until ?? null,
      plan_id: offer?.plan_id ?? null, window_kind: offer ? offer.window_kind ?? null : "weekly",
      confirmed: false, enabled: true, source: "user",
      source_url: offer?.source ?? null, note: offer ? `${offer.title.en}. ${offer.detail.en}` : null }]);
  }
  async function save() {
    setBusy(true); setError("");
    try {
      // Save only this account's terms, preserving its subscription/price history.
      const result = await api.plansSave({ subscription: row.subscription, capacity_regimes: regimes,
        expected_capacity_regimes: base ?? row.capacity_regimes ?? [] });
      const persisted = result.rows.find(r => r.subscription === row.subscription)?.capacity_regimes ?? regimes;
      setDraft(persisted); setBase(persisted); setModified(false); onEditing(false); setSaved(true); onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <div className="capacity-promotion-editor">
    <p>{t("Dates are inclusive UTC days. 1× declares no allowance boost; 2× means twice the regular allowance. A missing period is unknown. For promotion-free cycle estimates, both dates must cover the full cycle.", "Daty to dni UTC, włącznie. 1× oznacza deklarację braku zwiększenia limitu; 2× oznacza podwójny zwykły limit. Brak okresu to niewiadoma. Szacunek cyklu bez promocji wymaga obu dat obejmujących cały cykl.")}</p>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={busy}>
        {regimes.map((r, index) => <div key={r.id} className="capacity-promotion-row">
          <strong>{t("Period", "Okres")} {index + 1}</strong>
          <label>{t("From (UTC)", "Od (UTC)")}<input type="date" value={r.from ?? ""} required={r.confirmed !== false && r.enabled !== false} onChange={e => patch(r.id, { from: e.target.value || null })} /></label>
          <label>{t("Through (UTC)", "Do (UTC)")}<input type="date" value={r.until ?? ""} min={r.from ?? undefined} required={r.confirmed !== false && r.enabled !== false} onChange={e => patch(r.id, { until: e.target.value || null })} /></label>
          <label>{t("Multiplier", "Mnożnik")}<input type="number" min="0.01" max="100" step="any" value={Number.isFinite(r.factor) ? r.factor : ""} required onChange={e => patch(r.id, { factor: e.target.valueAsNumber })} /></label>
          <label>{t("Meter", "Licznik")}<Dropdown value={r.window_kind ?? ""} onChange={value => patch(r.id, { window_kind: value || null })} options={[
            { value: "", label: t("All meters", "Wszystkie liczniki") }, { value: "weekly", label: t("Weekly (main)", "Tygodniowy (główny)") },
            { value: "5h", label: t("5 hours", "5 godzin") }, { value: "spark-weekly", label: "Spark weekly" },
            ...(r.window_kind && !["weekly", "5h", "spark-weekly"].includes(r.window_kind) ? [{ value: r.window_kind, label: r.window_kind }] : []),
          ]} /></label>
          <label>{t("Plan", "Plan")}<Dropdown value={r.plan_id ?? ""} onChange={value => patch(r.id, { plan_id: value || null })} options={[
            { value: "", label: t("All plans on this account", "Wszystkie plany tego konta") },
            ...(group?.plans.map(p => ({ value: p.plan_id, label: p.label })) ?? []),
            ...(r.plan_id && !group?.plans.some(p => p.plan_id === r.plan_id) ? [{ value: r.plan_id, label: r.plan_id }] : []),
          ]} /></label>
          <label className="capacity-promotion-check"><input type="checkbox" checked={r.confirmed !== false} onChange={e => patch(r.id, { confirmed: e.target.checked, source: "user" })} />{t("Confirmed for this account", "Potwierdzone dla tego konta")}</label>
          <label className="capacity-promotion-check"><input type="checkbox" checked={r.enabled !== false} onChange={e => patch(r.id, { enabled: e.target.checked })} />{t("Enabled", "Włączone")}</label>
          <label className="capacity-promotion-wide">{t("Source URL (HTTPS)", "Adres źródła (HTTPS)")}<input type="url" value={r.source_url ?? ""} onChange={e => patch(r.id, { source_url: e.target.value || null })} /></label>
          <label className="capacity-promotion-wide">{t("Note / evidence", "Uwagi / potwierdzenie")}<input value={r.note ?? ""} onChange={e => patch(r.id, { note: e.target.value || null })} /></label>
        </div>)}
        {!regimes.length && <p>{t("No declared periods. Add one or use an announcement as a draft below.", "Brak zadeklarowanych okresów. Dodaj własny lub użyj poniższego ogłoszenia jako szkicu.")}</p>}
        <div className="capacity-promotion-actions">
          <button className="ui-button" type="button" onClick={() => add()}>+ {t("Add period", "Dodaj okres")}</button>
          <button className="ui-button" type="submit" disabled={!modified}>{busy ? t("Saving…", "Zapisywanie…") : t("Save periods", "Zapisz okresy")}</button>
          <button className="ui-button" type="button" disabled={!modified} onClick={() => { setDraft(null); setBase(null); setError(""); setSaved(false); setModified(false); onEditing(false); }}>{t("Discard changes", "Odrzuć zmiany")}</button>
        </div>
      </fieldset>
    </form>
    {error && <p role="alert">{error}</p>}
    {saved && <p role="status">{t("Saved. Reopen statistics to recalculate; recorded meter readings were not changed.", "Zapisano. Otwórz ponownie statystyki, aby je przeliczyć; zapisane odczyty licznika nie zostały zmienione.")}</p>}
    {modified && <p role="status">{t("Save or discard changes before choosing another account.", "Zapisz lub odrzuć zmiany przed wyborem innego konta.")}</p>}
    {codex && <CodexPromotionHistory onUse={busy ? undefined : add} />}
  </div>;
}
