import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, refreshApiData, type CycleSettingRow, type PlanSettingRow, type PlansCatalog } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useI18n } from "../lib/i18n";
import { buildSubscriptionRows, loadCapacities, subscriptionCapacityJobs, todayUtc } from "../lib/settings-rows";
import type { DataSettingsTarget } from "../lib/data-settings";
import type { AccountSettingsSection } from "../lib/settings-link";
import { ErrorState, LoadingCard } from "./ui";
import { holdsSubscription, type AccountSectionsSpec, type RailAccount } from "./AccountPeriodGroups";
import { SubscriptionsTable } from "./SubscriptionsTable";
import { CapacityPromotionsPanel } from "./CapacityPromotionsPanel";
import { WindowRhythmsPanel, rhythmRowKey } from "./WindowRhythmsPanel";
import { GrokAnchorPanel } from "./GrokAnchorPanel";
import { WindowEndSettings } from "./WindowEndSettings";

/** The sections Settings → Accounts adds under one account's timeline. */
export type AccountSection = AccountSettingsSection;

/** The /api/plans rows (one per accounts.json subscription) of one rail account. */
export function accountSubscriptions(account: RailAccount, rows: PlanSettingRow[]): PlanSettingRow[] {
  return rows.filter((row) => holdsSubscription(account, row.subscription, row.vendor));
}

/** The plan catalog, shared by every section (the GET is memoized, so several sections read it once). */
function useCatalog() {
  return useAsync(async () => (await api.plansCatalog()).catalog, []);
}

/** Price and calibration rows of the given subscriptions; capacities only for their plans on the "As of" day. */
function PriceTable({ rows, asOf, provider, selectedId, bare }: { rows: PlanSettingRow[]; asOf: string; provider: string; selectedId?: string | null; bare?: boolean }) {
  const { t } = useI18n();
  const catalogState = useCatalog();
  const catalog = catalogState.data;
  const jobs = useMemo(() => catalog ? subscriptionCapacityJobs(rows, catalog, asOf) : [], [catalog, rows, asOf]);
  // Keyed by the jobs' content: the rows of one account are a fresh array on every render.
  const capacityState = useAsync(async () => catalog ? loadCapacities(jobs) : null, [catalog, JSON.stringify(jobs)]);
  const tableRows = useMemo(
    () => catalog ? buildSubscriptionRows(rows, catalog, capacityState.data ?? new Map(), asOf, provider) : [],
    [catalog, rows, capacityState.data, asOf, provider],
  );
  if (catalogState.error) return <ErrorState message={catalogState.error} onRetry={catalogState.reload} />;
  if (!catalog) return <LoadingCard label={t("Loading subscriptions…", "Wczytuję subskrypcje…")} shape="table" />;
  return <SubscriptionsTable rows={tableRows} asOf={asOf} selectedId={selectedId} bare={bare} />;
}

function Promotions({ rows, target }: { rows: PlanSettingRow[]; target?: DataSettingsTarget }) {
  const { t } = useI18n();
  const catalogState = useCatalog();
  if (catalogState.error) return <ErrorState message={catalogState.error} onRetry={catalogState.reload} />;
  if (!catalogState.data) return <LoadingCard label={t("Loading Plan catalog…", "Wczytuję katalog Planów…")} shape="table" />;
  const initial = target && rows.some((row) => row.subscription === target.account) ? target : undefined;
  return <CapacityPromotionsPanel
    key={initial?.account ?? "promotions"}
    initialAccount={initial?.account}
    initialRange={initial?.since && initial.until ? { since: initial.since, until: initial.until } : undefined}
    rows={rows} catalog={catalogState.data} onSaved={refreshApiData} bare />;
}

/**
 * Window rhythms of the rows `belongs` keeps. The Grok anchor is one global setting: it sits in the row of the
 * Grok rolling window where that row is listed, and under the Grok group where no such row exists, as before.
 */
function Rhythms({ belongs, asOf, provider, grokTools, expandFor, bare }: {
  belongs: (row: CycleSettingRow) => boolean;
  asOf: string;
  provider: string;
  /** Whether the Grok group's own anchor tools may show here (no Grok rolling row anywhere). */
  grokTools: boolean;
  expandFor?: string | null;
  /** Inside one account's fold (see WindowRhythmsPanel). */
  bare?: boolean;
}) {
  const { t } = useI18n();
  const catalogState = useCatalog();
  const cyclesState = useAsync(() => api.cycles(), []);
  const [savedRows, setSavedRows] = useState<CycleSettingRow[] | null>(null);
  const allRows = savedRows ?? cyclesState.data?.rows ?? null;
  const catalog: PlansCatalog | null = catalogState.data;
  if (cyclesState.error) return <ErrorState message={cyclesState.error} onRetry={cyclesState.reload} />;
  if (catalogState.error) return <ErrorState message={catalogState.error} onRetry={catalogState.reload} />;
  if (!allRows || !cyclesState.data || !catalog) return <LoadingCard label={t("Loading versioned window rhythms…", "Wczytuję wersjonowane rytmy okien…")} shape="table" />;
  const grokGroup = catalog.provider_groups.find((group) =>
    [group.id, ...(group.aliases ?? [])].some((alias) => ["grok", "xai"].includes(alias.toLowerCase()))) ?? null;
  const grokRow = allRows.find((row) => row.vendor.toLowerCase() === "grok" && row.kind.toLowerCase() === "rolling") ?? null;
  const rows = allRows.filter(belongs);
  return <WindowRhythmsPanel
    defaultExpandedKeys={expandFor ? rows.filter((row) => row.subscription === expandFor).map(rhythmRowKey) : undefined}
    data={{ ...cyclesState.data, rows }}
    asOf={asOf}
    bare={bare}
    provider={provider}
    providerGroups={catalog.provider_groups.map((group) => ({ id: group.id, label: group.label, aliases: group.aliases }))}
    providerTools={grokGroup && !grokRow && grokTools ? { [grokGroup.id]: <GrokAnchorPanel /> } : {}}
    rowTools={grokRow && rows.includes(grokRow) ? { [rhythmRowKey(grokRow)]: <GrokAnchorPanel /> } : {}}
    onSave={async (request) => {
      const result = await api.cyclesSave(request);
      refreshApiData();
      setSavedRows(result.rows);
      return result;
    }}
  />;
}

/** One column no wider than the card: a wide table scrolls inside its panel instead of widening the timeline. */
const FIT = { gridTemplateColumns: "minmax(0, 1fr)" } as const;

/** A fold of the account card (the pattern of its "Plans in a table"); its content mounts, and loads, only while open. */
function Fold({ section, title, open, onToggle, scrollTo, onScrolled, children }: {
  section: string; title: string; open: boolean; onToggle: (open: boolean) => void; scrollTo?: boolean; onScrolled?: () => void; children: () => ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!scrollTo) return;
    ref.current?.scrollIntoView?.({ block: "start" });
    onScrolled?.();
  }, [scrollTo]);
  return <details ref={ref} className="account-history-fold" data-account-section={section} open={open}
    onToggle={(event) => { const next = event.currentTarget.open; if (next !== open) onToggle(next); }}>
    <summary>{title}</summary>
    {open && <div style={{ marginTop: 8 }}>{children()}</div>}
  </details>;
}

/** The "As of" day of the price, calibration and rhythm tables, beside the tables it changes. */
export function AsOfField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useI18n();
  return <label className="ui-selector account-settings-as-of">
    <span className="ui-selector-label">{t("As of", "Stan na dzień")}</span>
    <input type="date" value={value} onChange={(event) => onChange(event.target.value || todayUtc())} aria-label={t("As of date", "Stan na dzień")} className="mono" />
  </label>;
}

/**
 * Price and calibration, promotions and window rhythm of the account chosen in Settings → Accounts, as tabs of the
 * switcher under its timeline. Each reuses the panel the old Subscriptions and Window rhythms tabs showed, narrowed to
 * this account's subscriptions.
 */
export function accountSectionTabs({ account, subscriptions, asOf, onAsOf, target, t }: {
  account: RailAccount;
  /** All /api/plans rows; null while they are read. */
  subscriptions: PlanSettingRow[] | null;
  asOf: string;
  onAsOf: (value: string) => void;
  /** The link Settings opened with, when it names this account. */
  target?: DataSettingsTarget;
  t: (en: string, pl: string) => string;
}): AccountSectionsSpec {
  if (subscriptions === null) return { tabs: [], note: <p className="account-periods-note">{t("Reading subscriptions…", "Wczytuję abonamenty…")}</p> };
  const rows = accountSubscriptions(account, subscriptions);
  if (rows.length === 0) return { tabs: [], note: <p className="account-periods-note" data-account-sections="none">
    {t("No subscription entry — price, promotions and window rhythm do not apply to this account.",
      "Brak wpisu abonamentu — cena, promocje i rytm okien nie dotyczą tego konta.")}
  </p> };
  const linked = target && rows.some((row) => row.subscription === target.account) ? target : undefined;
  const tab = (key: AccountSection, label: string, body: () => ReactNode, dated = false) => ({ key, label, render: () =>
    <div className="account-history-lists" style={FIT} data-account-sections={account.account} data-account-section={key}>
      {dated && <div className="account-settings-tools"><AsOfField value={asOf} onChange={onAsOf} /></div>}
      {body()}
    </div> });
  return { tabs: [
    tab("price", t("Price and calibration", "Cena i kalibracja"), () =>
      <PriceTable rows={rows} asOf={asOf} provider="all" selectedId={linked?.area === "subscriptions" ? linked.account : null} bare />, true),
    tab("promotions", t("Promotions and capacity", "Promocje i pojemność"), () => <Promotions rows={rows} target={linked} />),
    tab("rhythm", t("Window rhythm", "Rytm okien"), () =>
      <Rhythms belongs={(row) => holdsSubscription(account, row.subscription, row.vendor)} asOf={asOf} provider="all"
        grokTools={account.provider === "grok"} expandFor={linked?.area === "cadence" ? linked.account : null} bare />, true),
    tab("windows", t("Windows", "Okna"), () => <WindowEndSettings account={account} cycle={target?.area === "windows" && holdsSubscription(account, target.account) ? target.cycle ?? null : null} />),
  ] };
}

/**
 * What "All accounts" adds: price and calibration of every subscription (the cross-account overview of the old
 * Subscriptions tab) and, folded, window rhythms no listed account holds, so no declared rhythm drops out of sight.
 */
export function AllAccountsSettings({ accounts, subscriptions, asOf, onAsOf, provider }: {
  accounts: RailAccount[];
  subscriptions: PlanSettingRow[] | null;
  asOf: string;
  onAsOf: (value: string) => void;
  provider: string;
}) {
  const { t } = useI18n();
  const [orphansOpen, setOrphansOpen] = useState(false);
  return <div className="account-history-lists" style={FIT} data-all-accounts-sections="1">
    <div className="account-settings-tools"><AsOfField value={asOf} onChange={onAsOf} /></div>
    {subscriptions === null ? <LoadingCard label={t("Loading subscriptions…", "Wczytuję subskrypcje…")} shape="table" />
      : <PriceTable rows={subscriptions} asOf={asOf} provider={provider} />}
    <Fold section="orphan-rhythms" title={t("Window rhythms without a listed account", "Rytmy okien bez konta na liście")}
      open={orphansOpen} onToggle={setOrphansOpen}>
      {() => <Rhythms belongs={(row) => !accounts.some((account) => holdsSubscription(account, row.subscription, row.vendor))}
        asOf={asOf} provider={provider} grokTools={false} />}
    </Fold>
  </div>;
}
