import { useMemo, useState } from "react";
import { api, type RateCardsResponse, type RateVariant, type RateVendor } from "../lib/api";
import { compact, full, usd } from "../lib/format";
import { translate, useI18n } from "../lib/i18n";
import { TableRow, Card, CardTitle, HelpBlock, HelpDot, Pill, Table, Td, Th } from "./ui";
import { CodexSpeedEditor } from "./CodexSpeedEditor";
import { classifyModelFamily } from "../lib/model-colors";
export { classifyModelFamily };
const RATE_COLUMNS: Array<{ key: string; label: string; hint: string }> = [
  { key: "in_uncached", label: "input", hint: "input not served from cache" },
  { key: "in_cache_read", label: "cache", hint: "input served from cache - 97% of Codex input traffic" },
  { key: "in_cache_write", label: "write", hint: "cache write" },
  { key: "in_cache_write_5m", label: "write 5m", hint: "cache write, 5 minute TTL" },
  { key: "in_cache_write_1h", label: "write 1h", hint: "cache write, 1 hour TTL" },
  { key: "out_total", label: "output", hint: "output including reasoning tokens" },
];

function rateColumnLabel(key: string): string {
  switch (key) {
    case "in_uncached": return translate("input", "input");
    case "in_cache_read": return translate("cache", "cache");
    case "in_cache_write": return translate("write", "zapis");
    case "in_cache_write_5m": return translate("write 5m", "zapis 5m");
    case "in_cache_write_1h": return translate("write 1h", "zapis 1h");
    case "out_total": return translate("output", "output");
    default: return translate(key, key);
  }
}

function rateColumnHint(key: string): string {
  switch (key) {
    case "in_uncached": return translate("input not served from cache", "input, który nie wyszedł z cache");
    case "in_cache_read": return translate("input served from cache - 97% of Codex input traffic", "input podany z cache - u Codeksa 97% ruchu wejściowego");
    case "in_cache_write": return translate("cache write", "zapis do cache");
    case "in_cache_write_5m": return translate("cache write, 5 minute TTL", "zapis do cache, TTL 5 minut");
    case "in_cache_write_1h": return translate("cache write, 1 hour TTL", "zapis do cache, TTL 1 godzina");
    case "out_total": return translate("output including reasoning tokens", "output razem z tokenami rozumowania");
    default: return translate(key, key);
  }
}
function columnsOf(vendor: RateVendor): typeof RATE_COLUMNS {
  const present = new Set<string>();
  for (const m of vendor.models) {
    for (const v of m.variants) {
      for (const key of Object.keys(v.rates)) present.add(key);
    }
  }
  if (present.size === 0) {
    if (vendor.vendor.toLowerCase() === "anthropic") {
      return RATE_COLUMNS.filter((c) => c.key !== "in_cache_write");
    }
    return RATE_COLUMNS.filter((c) => ["in_uncached", "in_cache_read", "out_total"].includes(c.key));
  }
  return RATE_COLUMNS.filter((c) => present.has(c.key));
}
function money(v: number | undefined): string {
  if (v == null) return "—";
  if (v === 0) return "0";
  return v >= 1 ? v.toFixed(2) : v.toFixed(3);
}
// Sizes on top of .ui-input / .ui-button: the frame, corners and colours come from the primitives.
const RATE_INPUT: React.CSSProperties = {
  width: 72,
  padding: "var(--s-1) var(--s-3)",
  fontSize: "var(--fs-3)",
  textAlign: "right",
};
const SMALL_BTN: React.CSSProperties = {
  padding: "var(--s-1) var(--s-5)",
  fontSize: "var(--fs-3)",
};
function parseDraft(
  cols: typeof RATE_COLUMNS,
  draft: Record<string, string>
): { rates: Record<string, number | null> } | { error: string } {
  const rates: Record<string, number | null> = {};
  for (const c of cols) {
    const raw = (draft[c.key] ?? "").trim().replace(",", ".");
    if (raw === "") {
      rates[c.key] = null;
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return { error: `${rateColumnLabel(c.key)}: ${translate("rate must be a non-negative number ($/1M)", "stawka musi być nieujemną liczbą ($/1M)")}` };
    rates[c.key] = n;
  }
  if (Object.values(rates).every((v) => v == null)) {
    return { error: translate("all fields are empty - a model without any rate cannot price traffic", "wszystkie pola puste - model bez żadnej stawki nie wycenia niczego") };
  }
  return { rates };
}
export function guessVendor(model: string, vendors: RateVendor[] = []): string | null {
  const family = classifyModelFamily(model);
  const vendorIds = new Set(vendors.map((v) => v.vendor.toLowerCase()));
  if (family && vendorIds.has(family)) {
    return family;
  }
  const m = model.toLowerCase();
  for (const v of vendors) {
    if (m.includes(v.vendor.toLowerCase())) return v.vendor;
  }
  return null;
}
export interface UnpricedItem {
  model: string;
  observed_provider?: string;
  rate_vendor?: string | null;
  tokens: number;
  reason: string;
  /** The first UTC day of such a call. */
  first_day?: string;
}
export interface RateCardsPanelProps {
  data: RateCardsResponse;
  asOf?: string;
  onSaved?: () => void;
  provider?: string;
  providerAliases?: string[];
  unpriced?: {
    tokens?: number;
    items?: UnpricedItem[];
    models?: Record<string, unknown>;
  };
  /** Codex (OpenAI) prices are dated periods with sources: their editor opens for an unpriced model instead of the quick form. */
  onPriceCodexModel?: (model: string, since?: string) => void;
}
function activeRateVariant(variants: RateVariant[], asOf: string): RateVariant | null {
  return variants.find(
    (variant) =>
      variant.kind === "period" &&
      (variant.from == null || variant.from <= asOf) &&
      (variant.until == null || asOf <= variant.until)
  ) ?? null;
}
export function RateCardsPanel({
  data,
  asOf = new Date().toISOString().slice(0, 10),
  onSaved,
  provider = "all",
  providerAliases,
  unpriced,
  onPriceCodexModel,
}: RateCardsPanelProps) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<{ vendor: string; model: string } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [draftName, setDraftName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const closeEditor = () => {
    setEditing(null);
    setAdding(null);
    setDraft({});
    setDraftName("");
    setErr(null);
  };
  const save = async (vendor: string, model: string, cols: typeof RATE_COLUMNS) => {
    const parsed = parseDraft(cols, draft);
    if ("error" in parsed) {
      setErr(parsed.error);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.saveRateCard({ vendor, model, rates: parsed.rates });
      closeEditor();
      onSaved?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const [premiumErr, setPremiumErr] = useState<{ vendor: string; message: string } | null>(null);
  const savePremium = async (vendor: string, enabled: boolean) => {
    setBusy(true);
    setPremiumErr(null);
    try {
      await api.saveVendorContextPremium({ vendor, long_context_premium: enabled });
      onSaved?.();
    } catch (e) {
      setPremiumErr({ vendor, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const targetIds = useMemo(() => {
    if (!provider || provider === "all") return null;
    const set = new Set<string>();
    set.add(provider.toLowerCase());
    if (providerAliases) {
      for (const a of providerAliases) {
        if (a) set.add(a.toLowerCase());
      }
    }
    return set;
  }, [provider, providerAliases]);
  const filteredSubs = useMemo(() => {
    if (!targetIds) return data.subscriptions;
    return data.subscriptions.filter(
      (s) =>
        targetIds.has((s.vendor ?? "").toLowerCase()) ||
        targetIds.has((s.rate_vendor ?? "").toLowerCase())
    );
  }, [data.subscriptions, targetIds]);
  const filteredVendors = useMemo(() => {
    if (!targetIds) return data.vendors;
    return data.vendors.filter((v) => targetIds.has(v.vendor.toLowerCase()));
  }, [data.vendors, targetIds]);
  const unpricedEntries = useMemo(() => {
    if (unpriced?.items && Array.isArray(unpriced.items)) {
      return unpriced.items.map((it) => ({
        model: it.model,
        observed_provider: it.observed_provider,
        rate_vendor: it.rate_vendor,
        tokens: it.tokens,
        reason: it.reason,
        first_day: it.first_day,
      }));
    }
    if (!unpriced?.models) return [];
    return Object.entries(unpriced.models).map(([model, val]) => {
      const tokens =
        typeof val === "number"
          ? val
          : typeof val === "object" && val && "tokens" in val && typeof (val as { tokens: unknown }).tokens === "number"
            ? (val as { tokens: number }).tokens
            : 0;
      const reason =
        typeof val === "object" && val && "reason" in val && typeof (val as { reason: unknown }).reason === "string"
          ? (val as { reason: string }).reason
          : "brak karty cennika w rate-cards.json";
      const observed_provider =
        typeof val === "object" && val && "observed_provider" in val && typeof (val as { observed_provider: unknown }).observed_provider === "string"
          ? (val as { observed_provider: string }).observed_provider
          : undefined;
      const rate_vendor =
        typeof val === "object" && val && "rate_vendor" in val && (typeof (val as { rate_vendor: unknown }).rate_vendor === "string" || (val as { rate_vendor: unknown }).rate_vendor === null)
          ? ((val as { rate_vendor: string | null }).rate_vendor)
          : undefined;
      return { model, tokens, reason, observed_provider, rate_vendor, first_day: undefined as string | undefined };
    });
  }, [unpriced]);
  const visibleUnpriced = useMemo(() => {
    if (!targetIds) return unpricedEntries;
    return unpricedEntries.filter((u) => {
      const effectiveVendor = u.rate_vendor ?? u.observed_provider;
      if (effectiveVendor && targetIds.has(effectiveVendor.toLowerCase())) return true;
      if (!u.rate_vendor && !u.observed_provider) {
        const family = classifyModelFamily(u.model);
        if (family && targetIds.has(family.toLowerCase())) return true;
        const g = guessVendor(u.model, data.vendors);
        return g != null && targetIds.has(g.toLowerCase());
      }
      return false;
    });
  }, [unpricedEntries, targetIds, data.vendors]);
  return (
    <>
      {visibleUnpriced.length > 0 && (
        <Card>
          <CardTitle
            title={t("Unpriced (models without a catalog rate)", "Bez stawki (Modele bez cennika)")}
            sub={`${compact(unpriced?.tokens ?? 0)} ${t("tokens are not priced in the portfolio", "tokenów nie wycenia się w portfelu")}`}
            help={t("Models observed in traffic without a declared rate.", "Modele zaobserwowane w ruchu bez zadeklarowanej stawki.")}
          />
          <div style={{ marginTop: 10, overflowX: "auto" }}>
            <Table tableId="RateCardsPanel:0">
              <thead>
                <TableRow header>
                  <Th columnId="c0">{t("model in traffic", "model w ruchu")}</Th>
                  <Th columnId="c1" align="right">{t("unpriced tokens", "niewycenione tokeny")}</Th>
                  <Th columnId="c2">{t("reason for missing rate", "powód braku stawki")}</Th>
                  <Th columnId="c3" align="right">{t("action", "akcja")}</Th>
                </TableRow>
              </thead>
              <tbody>
                {visibleUnpriced.map((item, idx) => {
                  const targetVendorId =
                    item.rate_vendor !== undefined
                      ? item.rate_vendor
                      : guessVendor(item.model, data.vendors);
                  const matchedVendor =
                    targetVendorId != null
                      ? (data.vendors.find((v) => v.vendor.toLowerCase() === targetVendorId.toLowerCase())?.vendor ?? null)
                      : null;
                  const itemKey = `${item.observed_provider ?? ""}::${item.model}::${idx}`;
                  const disabledReason =
                    item.rate_vendor === null
                      ? t("Provider {0} has no linked rate card (traffic cannot be converted)", `Dostawca ${item.observed_provider || "obcy"} nie ma powiązanej karty cennika (ruch nieprzeliczalny)`, [item.observed_provider || "unknown"])
                      : t("Provider rate card unavailable", "Brak karty cennika dostawcy");
                  const reasonText = item.reason === "missing_rate"
                    ? t("no rate in rate-cards.json", "brak stawki w rate-cards.json")
                    : item.reason === "no_rate_card"
                      ? t("no rate card for {0}", `brak karty cennika dostawcy ${item.observed_provider ?? ""}`.trim(), [item.observed_provider ?? t("this provider", "tego dostawcy")])
                      : item.reason === "brak karty cennika w rate-cards.json"
                        ? t("no rate card in rate-cards.json", "brak karty cennika w rate-cards.json")
                        : item.reason;
                  return (
                    <TableRow key={itemKey}>
                      <Td mono>
                        {item.model}
                        {item.observed_provider && (
                          <span style={{ marginLeft: 6, fontSize: "var(--fs-2)", color: "var(--muted)" }}>
                            ({item.observed_provider})
                          </span>
                        )}
                      </Td>
                      <Td mono align="right">
                        {full(item.tokens)}
                      </Td>
                      <Td style={{ color: "var(--warn)", fontSize: "var(--fs-3)" }}>
                        {reasonText}
                      </Td>
                      <Td align="right">
                        {matchedVendor ? (
                          <button className="ui-button"
                            style={SMALL_BTN}
                            onClick={() => {
                              if (matchedVendor === "openai" && onPriceCodexModel) { onPriceCodexModel(item.model, item.first_day); return; }
                              setAdding(matchedVendor);
                              setEditing(null);
                              setDraft({});
                              setDraftName(item.model);
                              setErr(null);
                            }}
                          >
                            + {t("price model", "wyceń model")}
                          </button>
                        ) : (
                          <span className="ui-tag" title={disabledReason}>
                            {t("provider card unavailable", "brak karty dostawcy")}
                          </span>
                        )}
                      </Td>
                    </TableRow>
                  );
                })}
              </tbody>
            </Table>
          </div>
          <div style={{ marginTop: 8, fontSize: "var(--fs-3)", color: "var(--warn)", lineHeight: 1.5 }}>
          {t("Traffic from these models is excluded from portfolio pricing and plan cost. Add a rate to the vendor catalog above to include its cost.", "Ruch tych modeli nie wchodzi do wyceny portfela ani nie obciąża kosztu Planów. Dodaj stawkę w cenniku vendora powyżej, aby uwzględnić ich koszt.")}
          </div>
        </Card>
      )}
      <Card>
        <CardTitle
          title={t("Subscriptions", "Abonamenty")}
          sub={`${usd(data.monthly_total_usd)}/${t("month", "mies")} ${t("total", "razem")}`}
          help={t("Declared in rate-cards.json and accounts.json.", "Deklarowane w rate-cards.json i accounts.json.")}
        />
        <div style={{ marginTop: 10, overflowX: "auto" }}>
          <Table tableId="RateCardsPanel:1">
            <thead>
              <TableRow header>
                <Th columnId="c0">{t("subscription", "subskrypcja")}</Th>
                <Th columnId="c1">{t("plan", "plan")}</Th>
                <Th columnId="c2" align="right">$/{t("month", "mies")}</Th>
                <Th columnId="c3">{t("vendor", "vendor")}</Th>
                <Th columnId="c4" title={t("Rate card used to calculate this subscription's traffic cost", "Karta cennika, z której liczony jest koszt ruchu tego abonamentu")}>{t("catalog", "cennik")}</Th>
                 <Th columnId="c5" align="right">{t("homes", "miejsca")}</Th>
                <Th columnId="c6">{t("confirmation", "potwierdzenie")}</Th>
              </TableRow>
            </thead>
            <tbody>
              {filteredSubs.map((s) => (
                <TableRow key={s.id}>
                  <Td mono>{s.id}</Td>
                  <Td>{s.plan ?? "—"}</Td>
                  <Td mono align="right">
                    {s.usd_per_month != null ? usd(s.usd_per_month) : "—"}
                  </Td>
                  <Td mono>{s.vendor ?? "—"}</Td>
                  <Td mono>{s.rate_vendor ?? "—"}</Td>
                  <Td mono align="right">
                    {s.declared_in_accounts ? (
                      <span style={{ color: s.home_count === 0 ? "var(--warn)" : "var(--text)" }}>{s.home_count}</span>
                    ) : (
                      <span style={{ color: "var(--faint)" }}>—</span>
                    )}
                  </Td>
                  <Td>
                    <Pill tone={s.confidence === "user-confirmed" ? "ok" : "neutral"}>
                       {s.confidence === "user-confirmed"
                         ? t("user confirmed", "potwierdzone przez użytkownika")
                         : s.confidence ?? (s.declared_in_accounts ? t("from accounts.json", "z accounts.json") : t("catalog only", "tylko cennik"))}
                    </Pill>
                  </Td>
                </TableRow>
              ))}
            </tbody>
          </Table>
        </div>
        <div style={{ marginTop: 10, fontSize: "var(--fs-3)", color: "var(--muted)", lineHeight: 1.55 }}>
          {t("This is the price WE PAY. Dollars on the other screens mean something else: the price of the same traffic in the API catalog, or what it would cost without a subscription. These are different quantities and are intentionally not summed.", "To jest cena, którą PŁACIMY. Wszystkie dolary na pozostałych ekranach są czymś innym: wyceną tego samego ruchu w cenniku API, czyli tym, ile kosztowałby bez abonamentu. Dwie różne wielkości, celowo nigdzie nie zsumowane.")}
        </div>
      </Card>
      <Card>
        <CardTitle
          title={t("Model rate cards over time", "Cenniki modeli w czasie")}
          sub={`${data.unit} · ${t("rate card version", "wersja cennika")} ${data.version} · ${t("as of", "stan na")} ${asOf}`}
          help={t("The rate is selected by event day where the vendor supports it.", "Stawka wybierana według dnia zdarzenia tam, gdzie vendor to umożliwia.")}
        />
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 0 }}>
          {filteredVendors.map((v, vendorIndex) => {
            const cols = columnsOf(v);
            return (
              <div key={v.vendor} style={{ padding: "var(--s-7) 0", borderTop: vendorIndex > 0 ? "var(--rule)" : undefined }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: "var(--fs-5)", fontWeight: "var(--fw-semibold)", color: "var(--text)" }}>{v.vendor}</span>
                  <Pill tone={v.verified ? "ok" : "warn"} dot>
                    {v.verified ? t("verified source", "źródło potwierdzone") : t("secondary source", "źródło wtórne")}
                  </Pill>
                  <Pill tone={v.day_scoped ? "neutral" : "warn"}>
                    {v.day_scoped ? t("day-scoped rate", "stawka per dzień") : t("current rate", "stawka bieżąca")}
                  </Pill>
                  <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
                    {v.model_count} {t("models", "modeli")}
                  </span>
                  {v.long_context_premium !== undefined && <label style={{ fontSize: "var(--fs-3)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <input type="checkbox" disabled={busy} checked={v.long_context_premium} onChange={e => void savePremium(v.vendor, e.target.checked)} />
                    {t("Long-context premium in API values", "Dopłata za długi kontekst w wartości API")}
                    <HelpDot label={t("Long-context premium", "Dopłata za długi kontekst")}>
                      <HelpBlock>{t("On: a request above its model's threshold (e.g. Claude Haiku 5.5 above 100K prompt tokens) is valued at its long-context rates in every API value of this vendor: cost, value and capacity. Off (default): base rates; the subscription meter is not known to count the premium. The uplift is measured either way and Capacity's Context impact previews it. Changing this revalues the long requests in the background.",
                        "Włączona: wywołanie ponad próg modelu (np. Claude Haiku 5.5 powyżej 100K tokenów wejścia) jest wyceniane stawkami długiego kontekstu we wszystkich wartościach API tego dostawcy: koszcie, wartości i pojemności. Wyłączona (domyślnie): stawki podstawowe; nie wiadomo, by licznik abonamentu liczył dopłatę. Kwota dopłaty jest liczona w obu stanach, a Wpływ kontekstu na Pojemności pokazuje ją w podglądzie. Zmiana przelicza w tle długie wywołania.")}</HelpBlock>
                    </HelpDot>
                  </label>}
                  {premiumErr?.vendor === v.vendor && <span role="alert" style={{ fontSize: "var(--fs-3)", color: "var(--warn)" }}>{premiumErr.message}</span>}
                </div>
                {v.source && (
                  <div className="mono" style={{ marginTop: 4, fontSize: "var(--fs-3)", color: "var(--muted)", lineHeight: 1.5 }}>
                    {v.source}
                  </div>
                )}
                {!v.day_scoped && (
                  <div style={{ marginTop: 4, fontSize: "var(--fs-3)", color: "var(--warn)", lineHeight: 1.5 }}>
                    {t("Queries for this vendor are grouped by model rather than (model, day). A catalog interval will work only after regrouping. No model from this vendor has an interval today, so no number changes.", "Zapytania dla tego vendora grupują po modelu, nie po (model, dzień). Okres wpisany do cennika zadziała dopiero po ich przegrupowaniu. Dziś żaden model tego vendora okresu nie ma, więc nie zmienia to żadnej liczby.")}
                  </div>
                )}
                <div style={{ marginTop: 8, overflowX: "auto" }}>
                  <Table tableId="RateCardsPanel:2">
                    <thead>
                      <TableRow header>
                        <Th columnId="c0">{t("model", "model")}</Th>
                        <Th columnId="c1">{t("period", "okres")}</Th>
                        {cols.map((c) => (
                          <Th columnId={`rate:${c.key}`} key={c.key} align="right" title={rateColumnHint(c.key)}>
                            {rateColumnLabel(c.key)}
                          </Th>
                        ))}
                        <Th columnId="c3"> </Th>
                      </TableRow>
                    </thead>
                    <tbody>
                      {v.models.flatMap((m) => {
                        const isEditing = editing?.vendor === v.vendor && editing.model === m.model;
                        const activeVariant = activeRateVariant(m.variants, asOf);
                        const editIndex = v.vendor === "openai" && activeVariant ? m.variants.indexOf(activeVariant) : 0;
                        return m.variants.map((variant, i) => {
                          const active = variant === activeVariant;
                          return (
                            <TableRow
                              key={`${m.model}-${variant.label}`}
                              data-rate-model={m.model}
                              data-rate-variant-kind={variant.kind}
                              data-rate-variant-from={variant.from ?? "origin"}
                              data-rate-variant-until={variant.until ?? "open"}
                              data-rate-active={active ? "true" : undefined}
                              style={{ background: active ? "var(--ok-soft)" : undefined }}
                            >
                            <Td mono>
                              {i === 0 ? (
                                <span style={{ color: m.priced ? "var(--text)" : "var(--faint)" }}>
                                  {m.model}
                                  {m.proxy_for ? (
                                    <span style={{ color: "var(--faint)" }}> ≈ {m.proxy_for}</span>
                                  ) : null}
                                </span>
                              ) : (
                                <span style={{ color: "var(--faint)" }}>↳</span>
                              )}
                              {i === 0 && <CodexSpeedEditor model={m} onSaved={onSaved} />}
                            </Td>
                            <Td>
                              <span
                                className="mono"
                                style={{
                                  fontSize: "var(--fs-3)",
                                  color: variant.kind === "mode" ? "var(--violet)" : "var(--muted)",
                                }}
                              >
                                {variant.label}
                              </span>
                              {active && (
                                <span style={{ marginLeft: 7 }}>
                                  <Pill tone="ok">{t("active", "aktywna")} {asOf}</Pill>
                                </span>
                              )}
                            </Td>
                            {cols.map((c) =>
                              isEditing && i === editIndex ? (
                                <Td key={c.key} align="right">
                                  <input
                                    className="ui-input"
                                    style={RATE_INPUT}
                                    value={draft[c.key] ?? ""}
                                    placeholder="—"
                                    aria-label={`${m.model} · ${rateColumnLabel(c.key)} ($/1M)`}
                                    onChange={(e) => setDraft((d) => ({ ...d, [c.key]: e.target.value }))}
                                  />
                                </Td>
                              ) : (
                                <Td key={c.key} mono align="right">
                                  {money(variant.rates[c.key])}
                                </Td>
                              )
                            )}
                            <Td align="right">
                              {i === editIndex &&
                                (isEditing ? (
                                  <span style={{ display: "inline-flex", gap: 6 }}>
                                    <button className="ui-button"
                                      style={{ ...SMALL_BTN, color: "var(--ok)" }}
                                      disabled={busy}
                                      onClick={() => save(v.vendor, m.model, cols)}
                                    >
                                      {busy ? "…" : t("save", "zapisz")}
                                    </button>
                                    <button className="ui-button" style={SMALL_BTN} disabled={busy} onClick={closeEditor}>
                                      {t("cancel", "anuluj")}
                                    </button>
                                  </span>
                                ) : (
                                  <button className="ui-button"
                                    style={SMALL_BTN}
                                    title={v.vendor === "openai"
                                      ? t("Edit current Standard rates. Codex API pricing will receive a new period starting today. Empty field means do not price it.", "Edytuj bieżące stawki Standard. Wycena Codex API otrzyma nowy okres od dziś. Puste pole oznacza brak wyceny.")
                                      : t("Edit this model's base rates. until/after periods and fast mode remain unchanged. Empty field means do not price it.", "Edytuj stawki bazowe tego modelu. Okresy (until/after) i tryb fast zostają nietknięte. Puste pole oznacza brak wyceny.")}
                                    onClick={() => {
                                      const base = m.variants[editIndex]?.rates ?? {};
                                      const seed: Record<string, string> = {};
                                      for (const c of cols) seed[c.key] = base[c.key] != null ? String(base[c.key]) : "";
                                      setEditing({ vendor: v.vendor, model: m.model });
                                      setAdding(null);
                                      setDraft(seed);
                                      setErr(null);
                                    }}
                                  >
                                    {t("edit", "edytuj")}
                                  </button>
                                ))}
                            </Td>
                            </TableRow>
                          );
                        });
                      })}
                      {adding === v.vendor && (
                        <TableRow>
                          <Td mono>
                            <input
                              className="ui-input"
                              style={{ ...RATE_INPUT, width: 180, textAlign: "left" }}
                              value={draftName}
                              placeholder={t("model ID, for example gpt-5.7", "id modelu, np. gpt-5.7")}
                              aria-label={`${t("new model for vendor", "nowy model vendora")} ${v.vendor}`}
                              onChange={(e) => setDraftName(e.target.value)}
                            />
                          </Td>
                          <Td>
                            <span className="mono" style={{ fontSize: "var(--fs-2)", color: "var(--faint)" }}>
                              {t("new", "nowy")}
                            </span>
                          </Td>
                          {cols.map((c) => (
                            <Td key={c.key} align="right">
                              <input
                                className="ui-input"
                                style={RATE_INPUT}
                                value={draft[c.key] ?? ""}
                                placeholder="—"
                                aria-label={`${t("new model", "nowy model")} · ${rateColumnLabel(c.key)} ($/1M)`}
                                onChange={(e) => setDraft((d) => ({ ...d, [c.key]: e.target.value }))}
                              />
                            </Td>
                          ))}
                          <Td align="right">
                            <span style={{ display: "inline-flex", gap: 6 }}>
                              <button className="ui-button"
                                style={{ ...SMALL_BTN, color: "var(--ok)" }}
                                disabled={busy || draftName.trim() === ""}
                                onClick={() => save(v.vendor, draftName.trim(), cols)}
                              >
                                {busy ? "…" : t("save", "zapisz")}
                              </button>
                              <button className="ui-button" style={SMALL_BTN} disabled={busy} onClick={closeEditor}>
                                {t("cancel", "anuluj")}
                              </button>
                            </span>
                          </Td>
                        </TableRow>
                      )}
                    </tbody>
                  </Table>
                </div>
                {err != null && (editing?.vendor === v.vendor || adding === v.vendor) && (
                  <div className="mono" style={{ marginTop: 6, fontSize: "var(--fs-3)", color: "var(--warn)" }}>
                    {err}
                  </div>
                )}
                {adding !== v.vendor && (
                  <button className="ui-button"
                    style={{ ...SMALL_BTN, marginTop: 8 }}
                    title={t("Add a model to this vendor. A model without a rate cannot price anything. Its traffic appears under unpriced tokens.", "Dodaj model do tego vendora. Model bez stawki nie wycenia niczego. Jego ruch ląduje w „tokeny bez stawki”.")}
                    onClick={() => {
                      setAdding(v.vendor);
                      setEditing(null);
                      setDraft({});
                      setDraftName("");
                      setErr(null);
                    }}
                  >
                    + {t("add model", "dodaj model")}
                  </button>
                )}
                {v.notes.length > 0 && (
                  <ul
                    className="mono"
                    style={{ margin: "8px 0 0", paddingLeft: 16, fontSize: "var(--fs-3)", color: "var(--muted)", lineHeight: 1.55 }}
                  >
                    {v.notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </Card>
    </>
  );
}
