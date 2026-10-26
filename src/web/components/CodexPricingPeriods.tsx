import { useEffect, useRef, useState } from "react";
import type { CodexAccountingRule, CodexTokenRates } from "../../shared/codex-accounting";
import type { DataSettingsTarget } from "../lib/data-settings";
import { api, refreshApiData } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useI18n } from "../lib/i18n";
import { TableRow, Card, CardTitle, Dropdown, ErrorState, HelpBlock, LoadingCard, Table, Th, Td } from "./ui";
import "./CodexPricingPeriods.css";

export function shiftPricingDay(day: string, days: number): string {
  const time = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(time) ? new Date(time + days * 86400000).toISOString().slice(0, 10) : "";
}

const emptyRates = (): CodexTokenRates => ({ in_uncached: NaN, in_cache_read: NaN, out_total: NaN });
const grid = { display: "flex", flexWrap: "wrap", gap: "var(--s-6)", alignItems: "end" } as const;

function RatesFields({ rates, onChange }: { rates: CodexTokenRates; onChange: (rates: CodexTokenRates) => void }) {
  const { t } = useI18n();
  return <div style={grid}>{([
    ["in_uncached", t("Uncached input", "Wejście bez cache")],
    ["in_cache_read", t("Cached input", "Odczyt cache")],
    ["out_total", t("Output (including reasoning)", "Wyjście (z reasoning)")],
  ] as const).map(([key, label]) => <label key={key}>{label}<br /><input type="number" min="0" step="any" required value={Number.isFinite(rates[key]) ? rates[key] : ""}
    onChange={e => onChange({ ...rates, [key]: e.target.valueAsNumber })} /></label>)}</div>;
}

export function CodexPricingPeriods({ target, onSaved }: { target?: DataSettingsTarget; onSaved: () => void }) {
  const { t } = useI18n();
  const state = useAsync(() => api.codexPricing(), []);
  const [model, setModel] = useState(target?.model ?? "");
  const [draft, setDraft] = useState<CodexAccountingRule | null>(null);
  const [replaceId, setReplaceId] = useState<string>();
  const [revision, setRevision] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [premiumBusy, setPremiumBusy] = useState(false);
  const [premiumError, setPremiumError] = useState("");
  const rules = state.data?.rules ?? [];
  const form = useRef<HTMLFormElement>(null);
  const models = [...new Set(rules.map(r => r.model).concat(target?.model ? [target.model] : []))].sort();
  const visible = rules.filter(r => !model || r.model === model).sort((a, b) => a.model.localeCompare(b.model) || a.billing_basis.localeCompare(b.billing_basis) || a.speed.localeCompare(b.speed) || a.valid_from.localeCompare(b.valid_from));
  function edit(rule?: CodexAccountingRule, clone = false) {
    if (!state.data) return;
    setDraft(rule ? { ...structuredClone(rule), ...(clone ? { id: `user:${crypto.randomUUID()}`, valid_from: target?.since ?? new Date().toISOString().slice(0, 10), valid_until: target?.until ? shiftPricingDay(target.until, 1) : undefined } : {}) } : {
      id: `user:${crypto.randomUUID()}`, model: model || target?.model || "", billing_basis: target?.basis ?? "api_equivalent_usd", speed: target?.speed ?? "standard",
      valid_from: target?.since ?? new Date().toISOString().slice(0, 10), valid_until: target?.until ? shiftPricingDay(target.until, 1) : undefined,
      verified_at: new Date().toISOString().slice(0, 10), confidence: "user", rates: emptyRates(), multiplier: 1, included_usage: "unknown",
      // A new model's period starts from the sources of the newest documented API period; the user checks them.
      sources: target?.newPeriod ? [...([...state.data.rules].filter(r => r.billing_basis === "api_equivalent_usd" && r.confidence !== "user")
        .sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0]?.sources ?? [""])] : [""],
    });
    setReplaceId(rule && !clone ? rule.id : undefined); setRevision(state.data.revision); setError(""); setSaved(false); setRemoving(false);
  }
  // A model without a price, sent from the rate table: its new period opens prefilled once the periods are read.
  const opened = useRef(false);
  useEffect(() => {
    if (!target?.newPeriod || !target.model || !state.data || opened.current) return;
    opened.current = true; edit();
  }, [state.data]); // eslint-disable-line react-hooks/exhaustive-deps
  // Bring the opened form into view inside its own scroll container; scrolling the document would shift the shell.
  useEffect(() => {
    const node = form.current;
    if (!draft || !target?.newPeriod || !node || typeof getComputedStyle !== "function") return;
    let box = node.parentElement;
    while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
    if (box) box.scrollTop += node.getBoundingClientRect().top - box.getBoundingClientRect().top - 16;
  }, [!!draft]); // eslint-disable-line react-hooks/exhaustive-deps
  async function save(remove = false) {
    if (!draft) return;
    setBusy(true); setError("");
    try {
      await api.saveCodexPricing(remove ? { revision, remove: draft.id } : { revision, replace_id: replaceId,
        rule: { ...draft, model: draft.model.trim(), sources: draft.sources.map(s => s.trim()).filter(Boolean), confidence: "user" } });
      setDraft(null); setSaved(true); state.reload(); refreshApiData(); onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function savePremium(value: boolean) {
    if (!state.data) return;
    setPremiumBusy(true); setPremiumError(""); setSaved(false);
    try {
      await api.saveCodexPricing({ revision: state.data.revision, long_context_premium: value });
      setSaved(true); state.reload(); refreshApiData(); onSaved();
    } catch (e) { setPremiumError((e as Error).message); }
    finally { setPremiumBusy(false); }
  }
  const affected = draft ? rules.filter(r => r.id !== replaceId && r.model === draft.model && r.billing_basis === draft.billing_basis && r.speed === draft.speed
    && r.valid_from < (draft.valid_until ?? "9999-12-31") && draft.valid_from < (r.valid_until ?? "9999-12-31")) : [];
  const original = rules.find(rule => rule.id === replaceId);
  const patch = (value: Partial<CodexAccountingRule>) => { if (draft) { setDraft({ ...draft, ...value }); setRemoving(false); } };
  return <div className="codex-pricing-periods"><Card pad="14px 16px">
    <CardTitle title={t("Codex: dated API and credit prices", "Codex: ceny API i kredytów w czasie")} help={<>
      <HelpBlock>{t("These periods price recorded requests by their UTC date. Applies to all accounts using this model.", "Te okresy wyceniają zapisane żądania według ich daty UTC. Dotyczą wszystkich kont używających modelu.")}</HelpBlock>
      <HelpBlock>{t("API dollars and credits are independent price tables. An included-usage declaration describes evidence; it does not multiply the recorded meter or set a fixed subscription credit budget.", "Dolary API i kredyty mają oddzielne cenniki. Deklaracja wpływu na abonament opisuje dowód; nie mnoży odczytów licznika ani nie ustala stałego budżetu kredytów abonamentu.")}</HelpBlock>
    </>} />
    {state.error && <ErrorState message={state.error} onRetry={state.reload} />}
    {state.loading && !state.data && <LoadingCard shape="table" />}
    {state.data && <><p><label><input type="checkbox" disabled={premiumBusy || !!draft} checked={state.data.long_context_premium}
      onChange={e => void savePremium(e.target.checked)} /> {t("Long-context premium in API equivalents", "Dopłata za długi kontekst w wartości API")}</label><br />
      <small>{t("Applies a period's long-context rates to a request above its threshold (e.g. 272K input tokens), as the paid API bills it, in every Codex API value: cost, value and capacity. Off by default: subscription credits have no such premium. Either way the uplift is measured, and Capacity's Context impact previews it. Changing this recalculates the Codex history of models with long-context rates in the background.",
        "Stosuje stawki długiego kontekstu z okresu do żądania powyżej progu (np. 272K tokenów wejścia), tak jak nalicza płatne API, we wszystkich wartościach API Codexa: koszcie, wartości i pojemności. Domyślnie wyłączone: kredyty abonamentu nie mają tej dopłaty. W obu stanach kwota dopłaty jest liczona, a Wpływ kontekstu na Pojemności pokazuje ją w podglądzie. Zmiana przelicza w tle historię Codexa modeli, które mają stawki długiego kontekstu.")}</small></p>
      {premiumError && <p role="alert">{premiumError}</p>}
      <div style={grid}><label>{t("Model filter", "Filtr modelu")} <Dropdown className="" disabled={!!draft} value={model} onChange={value => setModel(value)}
        options={[{ value: "", label: t("All models", "Wszystkie modele") }, ...models.map(m => ({ value: m, label: m }))]} /></label>
      <button type="button" disabled={!!draft} onClick={() => edit()}>+ {t("Add price period", "Dodaj okres ceny")}</button></div>
      {draft && <form ref={form} onSubmit={e => { e.preventDefault(); void save(); }} style={{ margin: "var(--s-8) 0" }}>
        <fieldset disabled={busy} style={{ display: "grid", gap: "var(--s-6)" }}><legend>{replaceId ? t("Edit period", "Edytuj okres") : t("New period", "Nowy okres")}</legend>
          <div style={grid}>
            <label>Model<br /><input required list="codex-pricing-models" value={draft.model} maxLength={120} onChange={e => patch({ model: e.target.value })} /><datalist id="codex-pricing-models">{models.map(m => <option key={m}>{m}</option>)}</datalist></label>
            <label>{t("Unit / 1M tokens", "Jednostka / 1 mln tokenów")}<br /><Dropdown className="" value={draft.billing_basis} onChange={value => patch({ billing_basis: value as CodexAccountingRule["billing_basis"], multiplier: 1 })}
              options={[{ value: "api_equivalent_usd", label: "API USD" }, { value: "chatgpt_credits", label: t("Credits", "Kredyty") }]} /></label>
            <label>Speed<br /><Dropdown className="" value={draft.speed} onChange={value => patch({ speed: value as CodexAccountingRule["speed"] })}
              options={[{ value: "standard", label: "Standard" }, { value: "fast", label: "Fast" }]} /></label>
            <label>{t("From UTC (inclusive)", "Od UTC (włącznie)")}<br /><input required type="date" value={draft.valid_from} onChange={e => patch({ valid_from: e.target.value })} /></label>
            <label>{t("Through UTC (inclusive; blank = ongoing)", "Do UTC (włącznie; puste = bez końca)")}<br /><input type="date" min={draft.valid_from} value={draft.valid_until ? shiftPricingDay(draft.valid_until, -1) : ""} onChange={e => patch({ valid_until: e.target.value ? shiftPricingDay(e.target.value, 1) : undefined })} /></label>
          </div>
          <RatesFields rates={draft.rates} onChange={rates => patch({ rates })} />
          {draft.billing_basis === "chatgpt_credits" && <label>{t("Credit rate multiplier", "Mnożnik stawek kredytowych")} <input type="number" min="0.000001" step="any" required value={Number.isFinite(draft.multiplier) ? draft.multiplier : ""} onChange={e => patch({ multiplier: e.target.valueAsNumber })} /> <small>{t("Effective price = base rate × multiplier.", "Cena efektywna = stawka bazowa × mnożnik.")}</small></label>}
          <label><input type="checkbox" checked={!!draft.long_context} onChange={e => patch({ long_context: e.target.checked ? { above_input_tokens: 272000, rates: emptyRates() } : undefined })} /> {t("Separate long-context rates", "Osobne stawki długiego kontekstu")}</label>
          {draft.long_context && <><label>{t("Above input tokens per request", "Powyżej tokenów wejścia na żądanie")} <input type="number" required min="1" step="1" value={Number.isFinite(draft.long_context.above_input_tokens) ? draft.long_context.above_input_tokens : ""} onChange={e => patch({ long_context: { ...draft.long_context!, above_input_tokens: e.target.valueAsNumber } })} /></label><RatesFields rates={draft.long_context.rates} onChange={rates => patch({ long_context: { ...draft.long_context!, rates } })} /></>}
          <label>{t("Included-usage effect (evidence)", "Wpływ na abonament (według dowodu)")} <Dropdown className="" value={draft.included_usage ?? "unknown"} onChange={value => patch({ included_usage: value as CodexAccountingRule["included_usage"] })} options={[
            { value: "unknown", label: t("Unverified", "Niepotwierdzony") },
            { value: "proportional", label: t("Proportional change declared", "Zadeklarowana zmiana proporcjonalna") },
            { value: "unchanged", label: t("Unchanged usage declared", "Zadeklarowane zużycie bez zmian") },
          ]} /></label>
          <label>{t("Sources (HTTPS, one per line)", "Źródła (HTTPS, jedno na linię)")}<br /><textarea required rows={2} style={{ width: "100%" }} value={draft.sources.join("\n")} onChange={e => patch({ sources: e.target.value.split("\n") })} /></label>
          <label>{t("Verification date", "Data sprawdzenia")} <input required type="date" value={draft.verified_at} onChange={e => patch({ verified_at: e.target.value })} /></label>
          <label>{t("Evidence / assumptions", "Dowody / założenia")}<br /><textarea rows={2} maxLength={2000} style={{ width: "100%" }} value={draft.note ?? ""} onChange={e => patch({ note: e.target.value })} /></label>
          <p>{t("Saved as a user declaration. The selected interval replaces overlapping prices only for this model, unit and mode. Earlier and later portions resume automatically.", "Zapis jako deklaracja użytkownika. Wybrany przedział zastępuje nakładające się ceny tylko tego modelu, jednostki i trybu. Wcześniejsze i późniejsze części zostają zachowane.")} {t("Overlapping periods", "Nakładające się okresy")}: {affected.length}.</p>
          {!!affected.length && <ul>{affected.map(r => <li key={r.id}>{r.valid_from} — {r.valid_until ? shiftPricingDay(r.valid_until, -1) : "∞"}: {r.rates.in_uncached} / {r.rates.in_cache_read} / {r.rates.out_total} × {r.multiplier}</li>)}</ul>}
          {replaceId && <p>{t("Editing replaces the entire selected period. Shortening it may leave a gap; use Copy as new period to preserve its prices outside a new interval.", "Edycja zastępuje cały wybrany okres. Skrócenie może pozostawić lukę; użyj Kopiuj jako nowy okres, aby zachować jego ceny poza nowym przedziałem.")}</p>}
          {error && <p role="alert">{error} <button type="button" onClick={() => { setDraft(null); state.reload(); }}>{t("Discard draft and reload", "Odrzuć szkic i odśwież")}</button></p>}
          <div style={grid}><button type="submit">{busy ? t("Saving…", "Zapisywanie…") : t("Save and recalculate", "Zapisz i przelicz")}</button><button type="button" onClick={() => setDraft(null)}>{t("Cancel", "Anuluj")}</button>{replaceId && <button type="button" onClick={() => setRemoving(true)}>{t("Remove period…", "Usuń okres…")}</button>}</div>
          {removing && original && <p role="alert">{t("Removing this period leaves its traffic unpriced unless another rate covers it. Confirm removal of", "Usunięcie okresu pozostawi ruch bez wyceny, jeśli nie obejmie go inna stawka. Potwierdź usunięcie")}: {original.model} · {original.billing_basis} · {original.speed} · {original.valid_from} — {original.valid_until ? shiftPricingDay(original.valid_until, -1) : "∞"}. <button type="button" onClick={() => void save(true)}>{t("Remove this period", "Usuń ten okres")}</button></p>}
        </fieldset>
      </form>}
      {saved && <p role="status">{t("Saved. Historical accounting and automatic price markers will use these periods.", "Zapisano. Rozliczenie historii i automatyczne znaczniki cen uwzględnią te okresy.")}</p>}
      <Table tableId="CodexPricingPeriods:0"><thead><TableRow header><Th columnId="c0">Model</Th><Th columnId="c1">{t("Period UTC (inclusive)", "Okres UTC (włącznie)")}</Th><Th columnId="c2">{t("Unit / mode", "Jednostka / tryb")}</Th><Th columnId="c3">{t("Input / cache / output per 1M", "Wejście / cache / wyjście za 1 mln")}</Th><Th columnId="c4">{t("Evidence", "Dowody")}</Th><Th columnId="c5">{t("Actions", "Akcje")}</Th></TableRow></thead>
        <tbody>{visible.map(r => <TableRow key={r.id}><Td>{r.model}</Td><Td>{r.valid_from} — {r.valid_until ? shiftPricingDay(r.valid_until, -1) : "∞"}</Td><Td>{r.billing_basis === "chatgpt_credits" ? t("credits", "kredyty") : "USD"} · {r.speed}</Td><Td mono>{r.rates.in_uncached} / {r.rates.in_cache_read} / {r.rates.out_total} × {r.multiplier}{r.long_context && <div>{`> ${r.long_context.above_input_tokens}: ${r.long_context.rates.in_uncached} / ${r.long_context.rates.in_cache_read} / ${r.long_context.rates.out_total}`}</div>}</Td><Td>{r.confidence === "user" ? t("User declaration", "Deklaracja użytkownika") : t("Documented rate", "Udokumentowana stawka")} · {r.verified_at}<details><summary>{t("Sources and assumptions", "Źródła i założenia")}</summary>{r.sources.map((s, i) => <div key={`${i}:${s}`}><a href={s} target="_blank" rel="noreferrer">{s}</a></div>)}{r.note && <p>{r.note}</p>}</details></Td><Td><button type="button" disabled={!!draft} onClick={() => edit(r)}>{t("Edit", "Edytuj")}</button> <button type="button" disabled={!!draft} onClick={() => edit(r, true)}>{t("Copy as new period", "Kopiuj jako nowy okres")}</button></Td></TableRow>)}</tbody></Table>
      {!visible.length && <p>{t("No price periods. Add the missing dated rate above.", "Brak okresów cenowych. Dodaj brakującą stawkę z datami powyżej.")}</p>}
    </>}
  </Card></div>;
}
