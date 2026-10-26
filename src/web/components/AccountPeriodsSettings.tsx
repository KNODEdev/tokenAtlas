import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  AccountDeclarationInput,
  AccountPeriodRow,
  AccountPeriodsView,
  PeriodEdit,
  PeriodEditPreview,
  PeriodSource,
  PlanDeclarationInput,
  PlanPeriodRow,
} from "../../shared/account-periods";
import type { PlanPriceCoverageSubject, PlanPriceGap } from "../../shared/plan-price-coverage";
import type { BillingCycle } from "../../shared/billing-cycles";
import { ApiError, api, refreshApiData } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useI18n } from "../lib/i18n";
import { NO_PLAN, isNoPlan } from "../../shared/period-end";
import { Dropdown, ErrorState, GhostButton, HelpDot, LoadingCard } from "./ui";
import { cycleMoney } from "./BillingCycles";
import "./AccountPeriodsSettings.css";
import { AccountPeriodDrawer } from "./AccountPeriodDrawer";
import { planName, shiftPeriod, type PeriodShift, type PlanPeriodSelection } from "./AccountHistoryTimeline";
import { AccountPeriodGroups, effectivePeriodRows, formatStamp, groupAccountPeriods, localStamp, periodKey, placesInPlan, planDisplay, type SourceTimeline } from "./AccountPeriodGroups";
export { formatStamp, planDisplay } from "./AccountPeriodGroups";

const PROVIDER_ORDER = ["claude", "codex", "gemini", "grok", "glm"];
const PROVIDER_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini", grok: "Grok", glm: "GLM" };
const providerRank = (provider: string) => {
  const index = PROVIDER_ORDER.indexOf(provider.toLowerCase());
  return index < 0 ? PROVIDER_ORDER.length : index;
};
const providerLabel = (provider: string) => PROVIDER_LABEL[provider.toLowerCase()] ?? provider;

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** A day-only value means that day's UTC midnight; everything else is an ISO instant. */
function instantOf(value: string): number {
  return Date.parse(DAY_ONLY.test(value) ? `${value}T00:00:00Z` : value);
}
const startOf = (value: string): number => {
  const ms = instantOf(value);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
};
const endOf = (value: string | null): number => {
  if (value === null) return Number.POSITIVE_INFINITY;
  const ms = instantOf(value);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
};
const compare = (a: number, b: number): number => (a === b ? 0 : a < b ? -1 : 1);
/** `datetime-local` carries no zone: the fields show this computer's clock and are stored as UTC instants. */
function toField(value: string | null): string {
  if (!value) return "";
  const ms = instantOf(value);
  return Number.isFinite(ms) ? localStamp(ms).replace(" ", "T") : "";
}
const FIELD = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
function toInstant(field: string): string {
  const parts = FIELD.exec(field)?.slice(1).map((part) => Number(part ?? 0));
  if (!parts) return field;
  const [year, month, day, hour, minute, second] = parts as [number, number, number, number, number, number];
  const ms = new Date(year, month - 1, day, hour, minute, second).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : field;
}
/** A stored stamp with its hour on this computer's clock; a day-only value is that day's UTC midnight. */
const stampAt = (value: string): string => {
  const ms = instantOf(value);
  return Number.isFinite(ms) ? localStamp(ms) : value;
};

export interface TimelineRow {
  key: string;
  kind: "period" | "gap" | "uncovered";
  provider: string;
  source: string;
  from: string;
  until: string | null;
  period: AccountPeriodRow | null;
  /** Observed rows a declared row hides inside its range; shown when the row is expanded. */
  covered: AccountPeriodRow[];
}

/**
 * Effective timeline of one source: declared rows win inside their range, the silence between
 * two periods is an explicit uncertain interval, and recorded events outside every period stay visible.
 */
export function buildSourceTimeline(source: PeriodSource, rows: AccountPeriodRow[]): TimelineRow[] {
  const declared = rows.filter((row) => row.origin === "declared");
  const covered = new Map<number, AccountPeriodRow[]>();
  for (const row of rows) {
    if (row.origin !== "observed") continue;
    for (const owner of declared.filter((d) => startOf(d.from) < endOf(row.until) && startOf(row.from) < endOf(d.until))) {
      covered.set(owner.id, [...(covered.get(owner.id) ?? []), row]);
    }
  }
  const effective = effectivePeriodRows(rows).map(({ row, from, until }) => ({ ...row, from, until, original: row }));
  const base: Pick<TimelineRow, "provider" | "source" | "period" | "covered"> = { provider: source.provider, source: source.key, period: null, covered: [] };
  const events = source.events;
  if (effective.length === 0) {
    return events ? [{ ...base, key: `${source.key}|events`, kind: "uncovered", from: events.first, until: events.last }] : [];
  }
  const out: TimelineRow[] = [];
  const first = effective[0]!;
  if (events && startOf(events.first) < startOf(first.from)) {
    out.push({ ...base, key: `${source.key}|before`, kind: "uncovered", from: events.first, until: first.from });
  }
  effective.forEach((row, index) => {
    const previous = effective[index - 1];
    if (previous && previous.until !== null && endOf(previous.until) < startOf(row.from)) {
      out.push({ ...base, key: `${source.key}|gap|${previous.id}`, kind: "gap", from: previous.until, until: row.from });
    }
    out.push({
      key: `${source.key}|row|${periodKey(row)}`, kind: "period", provider: row.provider, source: source.key,
      from: row.from, until: row.until, period: row.original, covered: covered.get(row.id) ?? [],
    });
  });
  const last = effective[effective.length - 1]!;
  if (events && last.until !== null && endOf(events.last) > endOf(last.until)) {
    out.push({ ...base, key: `${source.key}|after`, kind: "uncovered", from: last.until, until: events.last });
  }
  return out;
}

const OTHER = "\u0000other";
interface DraftBase {
  anchor: string;
  provider: string;
  account: string;
  accountOther: string;
  from: string;
  until: string;
  evidence: string;
  note: string;
  lockAccount?: boolean;
  /**
   * The stored instants the fields were filled from. The fields hold whole minutes, so an unchanged field keeps its
   * stored instant (a period ending at 09:55:57.164 must not move to 09:55 and overlap its neighbour).
   */
  exact?: { from?: string | null; until?: string | null; renewal?: string | null };
}
type Draft =
  | (DraftBase & { kind: "account"; source: string; replace: { source: string; from: string } | null })
  | (DraftBase & { kind: "plan"; plan: string; amount: string; currency: string; replace: { account: string; from: string } | null;
    /** The renewal instant of the billing cycles (empty: the start) and the cycle length, "1" or "12" months. */
    renewal?: string; cycleMonths?: string });

function editOf(draft: Draft, revision: string, remove: boolean): PeriodEdit {
  const account = (draft.account === OTHER ? draft.accountOther : draft.account).trim();
  const kept = (field: string, stored: string | null | undefined) =>
    stored && field === toField(stored) ? new Date(instantOf(stored)).toISOString() : toInstant(field);
  const from = kept(draft.from, draft.exact?.from);
  const until = draft.until ? kept(draft.until, draft.exact?.until) : null;
  const evidence = draft.evidence.trim();
  const note = draft.note.trim() || null;
  if (draft.kind === "account") {
    const row: AccountDeclarationInput | null = remove ? null : { provider: draft.provider, source: draft.source, account, from, until, evidence, note };
    return { revision, kind: "account", replace: draft.replace, row };
  }
  const amount = draft.amount.trim();
  const row: PlanDeclarationInput | null = remove ? null : {
    provider: draft.provider, account, plan: draft.plan.trim(), from, until, evidence, note,
    amount_minor: amount === "" ? null : Math.round(Number(amount) * 100),
    currency: draft.currency.trim().toUpperCase() || null,
    anchor: draft.renewal ? kept(draft.renewal, draft.exact?.renewal) : null,
    cycle_months: draft.cycleMonths === "12" ? 12 : null,
  };
  return { revision, kind: "plan", replace: draft.replace, row };
}

/** Settings' additions to the account card: a link's account and the sections under the timeline. */
export type AccountCardExtras = Pick<Parameters<typeof AccountPeriodGroups>[0], "selectAccount" | "accountSections" | "requestedSection" | "allAccountsSections">;
/** `focus` narrows the card to one account's history, as the Overview drawer shows it. */
export function AccountPeriodsSettings({ provider, providerAliases, focus = null, extras }: { provider: string; providerAliases: string[]; focus?: string | null; extras?: AccountCardExtras }) {
  const { t } = useI18n();
  const state = useAsync(() => api.accountPeriods(), []);
  const body = <>
    {state.error && <ErrorState message={state.error} onRetry={state.reload} />}
    {state.loading && !state.data && <LoadingCard label={t("Loading account periods…", "Wczytuję okresy kont…")} shape="table" />}
    {state.data && <PeriodsBody data={state.data} reload={state.reload} provider={provider} providerAliases={providerAliases} focus={focus} extras={extras} />}
  </>;
  return (
    <div className="account-periods">
      {/* Settings: the rail and the account stand on the tabs' rule; a card title would only repeat "Accounts". */}
      {body}
    </div>
  );
}

function PeriodsBody({ data, reload, provider, providerAliases, focus, extras }: {
  extras?: AccountCardExtras;
  data: AccountPeriodsView;
  reload: () => void;
  provider: string;
  providerAliases: string[];
  focus: string | null;
}) {
  const { t } = useI18n();
  const [view, setView] = useState(data);
  const [draft, setDraft] = useState<Draft | null>(null);
  const drawerOpener = useRef<HTMLElement | null>(null);
  const [drawerContext, setDrawerContext] = useState<{ plan?: PlanPeriodSelection; source?: { source: PeriodSource; row: TimelineRow } } | null>(null);
  const [preview, setPreview] = useState<PeriodEditPreview | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  // A background refresh of the same declarations keeps the checked preview; only another revision invalidates it.
  const shownRevision = useRef(data.revision);
  useEffect(() => {
    setView(data);
    if (data.revision !== shownRevision.current) setPreview(null);
    shownRevision.current = data.revision;
  }, [data]);
  // Read only while the Settings tab is open (not in the Overview drawer); a saved period refreshes it.
  const coverage = useAsync((signal) => focus == null ? api.planPriceCoverage(signal) : Promise.resolve(null), [focus]);
  // Billing cycles are stored rows: read once, and again shortly while the background producer catches up.
  const billing = useAsync((signal) => focus == null ? api.billingCycles(signal) : Promise.resolve(null), [focus]);
  /**
   * The billing range a save just invalidated: shown as being recalculated at once, before the next read reports it,
   * and cleared by a read made after the save that finds the account current.
   */
  const [billingPending, setBillingPending] = useState<{ provider: string; account: string; from: string; read: unknown } | null>(null);
  // An account the read does not list has no cycles to recalculate.
  const pendingCurrent = !!billingPending && !!billing.data && billing.data !== billingPending.read && !billing.data.accounts.some((entry) =>
    entry.provider === billingPending.provider && entry.account === billingPending.account.toLowerCase() && entry.stale);
  useEffect(() => { if (pendingCurrent) setBillingPending(null); }, [pendingCurrent]);
  const billingStale = !!billingPending || !!billing.data?.accounts.some((entry) => entry.stale);
  useEffect(() => {
    if (!billingStale) return;
    const timer = setTimeout(() => billing.reload(), billingPending ? 1500 : 4000);
    return () => clearTimeout(timer);
  }, [billingStale, billing.data]);

  const wanted = (provider === "all" ? [] : providerAliases.length ? providerAliases : [provider]).map((alias) => alias.toLowerCase());
  const matches = (value: string) => provider === "all" || wanted.includes(value.toLowerCase());
  const accountLabel = (id: string, forProvider?: string) =>
    view.accounts.find((a) => a.id === id && (!forProvider || a.provider === forProvider))?.label
    ?? view.accounts.find((a) => a.id === id)?.label
    ?? id;

  const sources = (() => {
    const known = new Map(view.sources.map((source) => [source.key, source]));
    for (const row of view.accountPeriods) {
      if (!known.has(row.source)) known.set(row.source, { provider: row.provider, key: row.source, machine: null, profile: null, events: null });
    }
    return [...known.values()]
      .filter((source) => matches(source.provider))
      .sort((a, b) => providerRank(a.provider) - providerRank(b.provider) || a.key.localeCompare(b.key));
  })();
  const timelines = sources
    .map((source) => ({ source, rows: buildSourceTimeline(source, view.accountPeriods.filter((row) => row.source === source.key)) }))
    .filter((entry) => entry.rows.length > 0);
  const planRows = view.planPeriods
    .filter((row) => matches(row.provider))
    .sort((a, b) =>
      providerRank(a.provider) - providerRank(b.provider)
      || accountLabel(a.account, a.provider).localeCompare(accountLabel(b.account, b.provider))
      || compare(startOf(a.from), startOf(b.from)));
  const knownPlans = [...new Set([
    ...view.planPeriods.filter((row) => row.provider === draft?.provider).map((row) => planDisplay(row.plan)),
    ...(draft?.provider === "claude" ? ["pro", "max-5x", "max-20x"] : draft?.provider === "codex" ? ["free", "plus", "pro"] : []),
  ])].filter((plan) => !isNoPlan(plan)).sort();
  // The built-in "no subscription" value closes a paid-plan gap at $0 for any provider; listed last.
  const planChoices = [...knownPlans, NO_PLAN];
  const visibleProviders = [...new Set([...sources.map((s) => s.provider), ...planRows.map((r) => r.provider)])]
    .sort((a, b) => providerRank(a) - providerRank(b));
  /** A new payment's currency: the account's latest declared one, else USD (the catalog's). */
  const currencyOf = (provider: string, account: string) => view.planPeriods
    .filter((row) => row.origin === "declared" && row.currency && row.provider === provider && row.account === account)
    .sort((a, b) => compare(startOf(b.from), startOf(a.from)))[0]?.currency ?? "USD";
  /** The stored USD equivalent of a declared row's payment: the billing cycle that starts with it. */
  const paymentUsd = (row: PlanPeriodRow) => {
    if (row.origin !== "declared" || row.amountMinor == null) return null;
    const cycle = billing.data?.accounts.find((entry) => entry.provider === row.provider && entry.account === row.account)?.cycles
      .find((item) => item.price.source === "declared" && item.declared_from !== null && startOf(item.declared_from) === startOf(row.from));
    return cycle?.price.usd != null && cycle.price.fx ? { usd: cycle.price.usd, day: cycle.price.fx.effective_day,
      amount: (row.amountMinor / 100).toFixed(2), currency: row.currency ?? "" } : null;
  };

  function open(next: Draft, context: typeof drawerContext = null) {
    if (!draft) drawerOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDrawerContext(context); setExpanded(null);
    setDraft(next); setPreview(null); setError(null); setStale(false); setRemoving(null);
  }
  const patch = (values: Partial<DraftBase>) => {
    setDraft((current) => (current ? { ...current, ...values } : current));
    setPreview(null);
  };
  const patchPlan = (values: Partial<{ plan: string; amount: string; currency: string; renewal: string; cycleMonths: string }>) => {
    setDraft((current) => (current && current.kind === "plan" ? { ...current, ...values } : current));
    setPreview(null);
  };
  async function run(mode: "preview" | "save" | "save-ending-earlier" | "remove", target = draft) {
    if (!target) return;
    setBusy(true); setError(null); setStale(false);
    try {
      const edit = { ...editOf(target, view.revision, mode === "remove"), ...(mode === "save-ending-earlier" ? { end_earlier: true } : {}) };
      if (mode === "preview") setPreview(await api.previewPeriodEdit(edit));
      else await save(edit);
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  }
  async function save(edit: PeriodEdit) {
    const result = await api.savePeriodEdit(edit);
    const range = result.preview.billing ?? preview?.billing;
    if (range) setBillingPending({ ...range, read: billing.data });
    setView(result.view); setDraft(null); setDrawerContext(null); setPreview(null); setRemoving(null);
    refreshApiData();
  }
  function failed(e: unknown) {
    setError(e instanceof Error ? e.message : String(e));
    if (e instanceof ApiError && e.status === 409) setStale(true);
  }
  /** The overlap fix: the draft ends exactly where the next period starts, and its impact is checked again. */
  function endBefore(at: string) {
    if (!draft) return;
    const next = { ...draft, until: toField(at), exact: { ...draft.exact, until: at } };
    setDraft(next); setPreview(null);
    void run("preview", next);
  }
  /**
   * A drag only proposes dates: at chart scale one pixel is hours, and an accidental drag must not
   * rewrite a declaration. The editor opens with the moved dates and their impact already checked.
   */
  function openDragged(target: Draft, context: NonNullable<typeof drawerContext>) {
    open(target, context);
    void run("preview", target);
  }

  function closeDrawer() {
    if (busy) return;
    setDraft(null); setDrawerContext(null); setPreview(null); setError(null); setRemoving(null);
  }
  function sourceDraft(row: TimelineRow, shift?: PeriodShift): Draft {
    const period = row.period;
    const known = period && view.accounts.some((a) => a.provider === period.provider && a.id === period.account);
    const dates = shift ? shiftPeriod(row.from, row.until, shift) : row;
    return {
      kind: "account", anchor: row.key, provider: row.provider, source: row.source,
      account: known ? period!.account : period ? OTHER : "", accountOther: period && !known ? period.account : "",
      from: toField(dates.from), until: toField(dates.until), exact: { from: row.from, until: row.until },
      evidence: period?.origin === "declared" ? period.evidence : period ? "correction" : "owner-declaration", note: period?.note ?? "",
      replace: period?.origin === "declared" ? { source: period.source, from: period.from } : null,
    };
  }
  /** Without a shift this opens the editor; a dragged period without a known account still needs one chosen there. */
  function onSourcePeriod(source: PeriodSource, row: TimelineRow, shift?: PeriodShift) {
    const context = { source: { source, row } };
    if (shift && row.period) openDragged(sourceDraft(row, shift), context);
    else open(sourceDraft(row, shift), context);
  }
  /**
   * A dragged plan bar becomes one declaration covering the bar's new dates; it replaces the bar's own
   * declaration, if any. A bar mixing accounts, plans or several declarations is ambiguous and opens the editor.
   */
  function onPlanPeriod(selection: PlanPeriodSelection, shift?: PeriodShift) {
    const records = selection.records;
    const declared = records.filter((row) => row.origin === "declared");
    const single = new Set(records.map((row) => row.account)).size === 1
      && new Set(records.map((row) => planDisplay(row.plan))).size === 1 && declared.length <= 1;
    if (!shift || !records.length || !single) { openPlan(selection, shift); return; }
    const dates = shiftPeriod(selection.from, selection.until, shift);
    const draft = planDraft(selection, undefined, declared[0] ?? records[0]);
    openDragged({ ...draft, from: toField(dates.from), until: toField(dates.until) }, { plan: selection });
  }
  /** A stretch without a plan price opens the plan editor on its dates, as the ✎ of a plan-less bar does. */
  function onPriceGap(subject: PlanPriceCoverageSubject, gap: PlanPriceGap) {
    onPlanPeriod({ provider: subject.provider, account: subject.account, aliases: [subject.account], from: gap.from_ts, until: gap.until_ts, records: [] });
  }
  /**
   * A billing cycle opens the plan editor (§8): a declared cycle edits its row (renewal day, end, amount, plan); a cycle
   * from readings starts a declaration of its run from the guessed payment day; an inferred one ("Confirm") a row for
   * exactly that cycle, with its impact already checked.
   */
  function onCycle(owner: { provider: string; account: string; aliases: string[] }, cycle: BillingCycle, confirm?: boolean) {
    const at = (value: string | null) => value === null ? null : startOf(value);
    const record = cycle.declared_from === null ? undefined : view.planPeriods.find((row) => row.origin === "declared"
      && owner.aliases.includes(row.account) && at(row.from) === at(cycle.declared_from));
    if (record) { openPlan({ provider: owner.provider, account: record.account, aliases: owner.aliases, from: record.from, until: record.until, records: [record] }, undefined, record); return; }
    const account = owner.account;
    const known = view.accounts.some((a) => a.provider === owner.provider && a.id === account);
    const inferred = cycle.basis === "inferred";
    const next: Draft = {
      kind: "plan", anchor: `plan|cycle|${owner.provider}|${account}|${cycle.start}`, provider: owner.provider, lockAccount: true,
      account: known ? account : OTHER, accountOther: known ? "" : account, plan: planDisplay(cycle.plan),
      from: toField(inferred ? cycle.start : cycle.run.from), until: inferred ? toField(cycle.end) : "",
      exact: { from: inferred ? cycle.start : cycle.run.from, until: inferred ? cycle.end : null },
      amount: "", currency: currencyOf(owner.provider, account), evidence: inferred ? "confirmed-cycle" : "owner", note: "", replace: null, renewal: "", cycleMonths: String(cycle.cycle_months),
    };
    const context = { plan: { provider: owner.provider, account, aliases: owner.aliases, from: inferred ? cycle.start : cycle.run.from,
      until: inferred ? cycle.end : null, records: [] } };
    if (confirm) openDragged(next, context); else open(next, context);
  }
  function openSource(source: PeriodSource, row: TimelineRow) {
    open(sourceDraft(row), { source: { source, row } });
  }
  function openPlan(selection: PlanPeriodSelection, shift?: PeriodShift, selectedRecord?: PlanPeriodRow) {
    open(planDraft(selection, shift, selectedRecord), { plan: selection });
  }
  function planDraft(selection: PlanPeriodSelection, shift?: PeriodShift, selectedRecord?: PlanPeriodRow): Draft {
    const row = selectedRecord ?? selection.records.find((item) => item.account === selection.account && item.origin === "declared")
      ?? selection.records.find((item) => item.account === selection.account) ?? selection.records[0];
    const account = row?.account ?? selection.account;
    const known = view.accounts.some((a) => a.provider === selection.provider && a.id === account);
    const stored = row ? { from: row.from, until: row.until } : selection;
    const dates = shift ? shiftPeriod(stored.from, stored.until, shift) : stored;
    return {
      kind: "plan", anchor: row ? `plan|${row.id}` : "plan|gap", provider: selection.provider, lockAccount: true,
      account: known ? account : OTHER, accountOther: known ? "" : account,
      plan: row ? planDisplay(row.plan) : "", from: toField(dates.from), until: toField(dates.until),
      exact: { from: stored.from, until: stored.until, renewal: row?.origin === "declared" ? row.anchor ?? null : null },
      amount: row?.amountMinor == null ? "" : (row.amountMinor / 100).toFixed(2), currency: row?.currency ?? currencyOf(selection.provider, account),
      evidence: row?.origin === "declared" ? row.evidence : row ? "correction" : "owner-declaration", note: row?.note ?? "",
      replace: row?.origin === "declared" ? { account: row.account, from: row.from } : null,
      renewal: row?.origin === "declared" && row.anchor ? toField(row.anchor) : "", cycleMonths: String(row?.origin === "declared" ? row.cycleMonths ?? 1 : 1),
    };
  }
  const sourceTable = (entries: SourceTimeline[]) => <div className="account-periods-entries">
    {entries.flatMap(({ source, rows }) => rows.map((row) => <button type="button" className="account-periods-unassigned-period" key={row.key}
      disabled={busy || !!draft} onClick={() => openSource(source, row)}>
      <strong>{source.machine ?? source.key}{source.profile ? ` · ${source.profile}` : ""}</strong>
      <span>{formatStamp(row.from)} → {row.until ? formatStamp(row.until) : t("now", "teraz")}</span>
      <span className="account-periods-warn">{row.kind === "gap" ? t("Uncertain account", "Niepewne konto") : t("Unknown account", "Nieznane konto")}</span>
      <span>{t("Assign account →", "Przypisz konto →")}</span>
    </button>))}
  </div>;
  const original = drawerContext?.source?.row.period
    ?? drawerContext?.plan?.records.find((row) => draft?.anchor === `plan|${row.id}`) ?? null;
  const source = drawerContext?.source?.source;
  const planPlaces = drawerContext?.plan ? placesInPlan(timelines, drawerContext.plan, drawerContext.plan.aliases) : [];

  return (
    <>
      {view.declarations.errors.length > 0 && (
        <div className="account-periods-reject" role="alert">
          <span aria-hidden="true">&#9888;</span>
          <div>
            <div className="account-periods-reject-title">
              {t("The declarations file is rejected as a whole; the rows of the previous good version stay in place.",
                "Plik deklaracji jest odrzucony w całości; zostają wiersze z poprzedniej dobrej wersji.")}
            </div>
            <div className="mono account-periods-reject-file">{view.declarations.file}</div>
            <ul className="mono">{view.declarations.errors.map((message) => <li key={message}>{message}</li>)}</ul>
          </div>
        </div>
      )}
      {error && !draft && <p role="alert" className="account-periods-warn">
        {error}
        {stale && <> <GhostButton onClick={reload}>{t("Refresh", "Odśwież")}</GhostButton></>}
      </p>}
      {draft && <AccountPeriodDrawer busy={busy} onClose={closeDrawer} returnFocus={drawerOpener.current}
        title={draft.kind === "plan" ? t("Edit plan period", "Edycja okresu planu") : t("Edit account period", "Edycja okresu konta")}
        subtitle={`${providerLabel(draft.provider)} · ${source ? [source.machine ?? source.key, source.profile].filter(Boolean).join(" · ") : accountLabel(draft.account === OTHER ? draft.accountOther : draft.account, draft.provider)}`}>
        {(drawerContext?.plan?.records.length ?? 0) > 1 && <label className="account-period-drawer-record">
          <span>{t("Record to correct", "Zapis okresu do poprawienia")}<HelpDot label={t("Record to correct", "Zapis okresu do poprawienia")}>{t(
            "This account has several source records. The correction applies to the selected record.", "Konto ma kilka zapisów źródłowych. Korekta dotyczy wybranego zapisu.")}</HelpDot></span>
          <Dropdown className="" disabled={busy} value={draft.anchor} onChange={(value) => {
            const context = drawerContext!.plan!;
            const row = context.records.find((item) => `plan|${item.id}` === value);
            if (row) openPlan(context, undefined, row);
          }} options={drawerContext!.plan!.records.map((row) => ({ value: `plan|${row.id}`,
            label: `${planName(row.plan, row.provider)} · ${formatStamp(row.from)} → ${row.until ? formatStamp(row.until) : t("now", "teraz")} · ${row.account}` }))} />
        </label>}
        <PeriodEditor key={draft.anchor} draft={draft} view={view} busy={busy} preview={preview} error={error} stale={stale} knownPlans={planChoices}
          paidUsd={draft.kind === "plan" && original && "plan" in original ? paymentUsd(original) : null}
          accountLabel={accountLabel} providers={draft.kind === "plan" && draft.lockAccount ? [draft.provider] : visibleProviders}
          onPatch={patch} onPatchPlan={patchPlan} onCancel={closeDrawer}
          onPreview={() => void run("preview")} onSave={() => void run("save")} onSaveEndingEarlier={() => void run("save-ending-earlier")} onEndBefore={endBefore} onReload={reload}
          onRemove={draft.replace ? () => setRemoving(draft.anchor) : undefined}
          removing={removing === draft.anchor} onConfirmRemove={() => void run("remove")} onCancelRemove={() => setRemoving(null)}>
          {drawerContext?.plan && <details className="account-periods-form-extra">
            <summary>{t("Places in this period", "Miejsca w tym okresie")}</summary>
            <section aria-label={t("Places in this period", "Miejsca w tym okresie")}>
              {planPlaces.length ? <ul>{planPlaces.map((item) => <li key={item.key}><strong>{item.source.machine ?? item.source.key} {item.source.profile}</strong>
                <br />{formatStamp(item.from)} → {item.until ? formatStamp(item.until) : t("now", "teraz")}</li>)}</ul>
                : <p>{t("No confirmed places of use for these dates.", "Brak potwierdzonych miejsc używania w tych datach.")}</p>}
            </section>
          </details>}
          {original && <Origin row={original} covered={drawerContext?.source?.row.covered ?? []} expanded={expanded === draft.anchor}
            onToggle={() => setExpanded(expanded === draft.anchor ? null : draft.anchor)}
            planEvidence={draft.kind === "plan" && original.origin === "declared" ? view.planPeriods.filter((row) =>
              row.provider === original.provider && row.account === original.account && row.origin === "observed"
              && startOf(row.from) < endOf(original.until) && startOf(original.from) < endOf(row.until)) : []} />}
          {expanded === draft.anchor && drawerContext?.source?.row.covered.map((row) => <p key={row.id} className="account-periods-note">
            {t("Observed original", "Zaobserwowany oryginał")}: {accountLabel(row.account, row.provider)} · {formatStamp(row.from)} → {row.until ? formatStamp(row.until) : t("now", "teraz")}
          </p>)}
        </PeriodEditor>
      </AccountPeriodDrawer>}
      <AccountPeriodGroups
        accounts={view.accounts.filter((account) => matches(account.provider))}
        timelines={timelines} plans={planRows} providers={visibleProviders} providerLabel={providerLabel}
        renderSources={sourceTable} onPlanPeriod={onPlanPeriod} onSourcePeriod={onSourcePeriod} editing={busy || !!draft} focus={focus}
        priceCoverage={focus == null ? { subjects: coverage.data?.subjects.filter((subject) => matches(subject.provider)) ?? null, error: coverage.error } : undefined}
        onPriceGap={onPriceGap} {...extras}
        {...(focus == null ? { billingCycles: billing.data?.accounts ?? null, billingPending, onCycle } : {})}
        addPlan={(provider, account) => open({
          kind: "plan", anchor: `plan|new|${provider}|${account}`, provider, lockAccount: !!account,
          account: view.accounts.some((item) => item.provider === provider && item.id === account) ? account : OTHER,
          accountOther: view.accounts.some((item) => item.provider === provider && item.id === account) ? "" : account,
          plan: "", from: "", until: "", amount: "", currency: currencyOf(provider, account), evidence: "owner-declaration", note: "", replace: null,
        })}

      />
    </>
  );
}

/** The stored UTC instant of a local field, for the field's tooltip. */
function utcTitle(field: string | undefined): string | undefined {
  const ms = field ? Date.parse(toInstant(field)) : NaN;
  return Number.isFinite(ms) ? `UTC ${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}` : undefined;
}

type DeclaredRow = AccountPeriodRow | PlanPeriodRow;
/**
 * Declared periods of the draft's account (plan) or place (account) that its dates run into; the server rejects them
 * as overlaps. `later` ones start after the draft's start, so ending the draft at the first of them resolves it.
 */
function overlapsOf(draft: Draft, view: AccountPeriodsView): { earlier: DeclaredRow[]; later: DeclaredRow[] } {
  const row = editOf(draft, view.revision, false).row;
  const from = row ? startOf(row.from) : NaN;
  if (!row || !Number.isFinite(from)) return { earlier: [], later: [] };
  const until = endOf(row.until);
  const replaced = (candidate: DeclaredRow) => !!draft.replace && startOf(draft.replace.from) === startOf(candidate.from)
    && ("plan" in candidate ? "account" in draft.replace && draft.replace.account === candidate.account
      : "source" in draft.replace && draft.replace.source === candidate.source);
  const rows: DeclaredRow[] = draft.kind === "plan"
    ? view.planPeriods.filter((item) => item.provider === draft.provider && item.account === row.account)
    : view.accountPeriods.filter((item) => item.source === draft.source);
  const hit = rows.filter((item) => item.origin === "declared" && !replaced(item)
    && startOf(item.from) < until && from < endOf(item.until))
    .sort((a, b) => compare(startOf(a.from), startOf(b.from)));
  return { earlier: hit.filter((item) => startOf(item.from) <= from), later: hit.filter((item) => startOf(item.from) > from) };
}
const OVERLAP_ERROR = "nakładające się okresy";

function Origin({ row, covered, expanded, onToggle, planEvidence = [] }: {
  row: AccountPeriodRow | PlanPeriodRow | null;
  covered: AccountPeriodRow[];
  expanded: boolean;
  onToggle: () => void;
  planEvidence?: PlanPeriodRow[];
}) {
  const { t } = useI18n();
  if (!row) return <span className="account-periods-warn">{t("no readings", "brak odczytów")}</span>;
  return (
    <details className="account-periods-evidence">
      <summary>{row.origin === "observed" ? t("From readings", "Z odczytów") : t("Your declaration", "Twój wpis")}</summary>
      <div className="account-periods-evidence-body">
        <div>{t("Evidence", "Podstawa")}: {row.evidence}</div>
        {row.note && <div>{row.note}</div>}
        {planEvidence.map((original) => <div key={original.id}>
          {t("Observed original", "Zaobserwowany oryginał")}: {planDisplay(original.plan)} · {formatStamp(original.from)} → {original.until ? formatStamp(original.until) : t("ongoing", "trwa")}
        </div>)}
        {row.origin === "observed" && <>
          <div>{t("Readings", "Odczyty")}: {row.readings.toLocaleString()}</div>
          <div>{t("First", "Pierwszy")}: {row.firstSeen ? formatStamp(row.firstSeen) : "—"}</div>
          <div>{t("Last", "Ostatni")}: {row.lastSeen ? formatStamp(row.lastSeen) : "—"}</div>
        </>}
        {covered.length > 0 && <button type="button" className="account-periods-expand" aria-expanded={expanded} onClick={onToggle}>
          {expanded ? "▾" : "▸"} {t("observed original", "zaobserwowany oryginał")} ({covered.length})
        </button>}
      </div>
    </details>
  );
}

function PeriodEditor({ draft, view, busy, preview, error, stale, knownPlans, paidUsd = null, providers, accountLabel, onPatch, onPatchPlan, onCancel, onPreview, onSave, onSaveEndingEarlier, onEndBefore, onReload, children, onRemove, removing, onConfirmRemove, onCancelRemove }: {
  draft: Draft;
  view: AccountPeriodsView;
  busy: boolean;
  preview: PeriodEditPreview | null;
  error: string | null;
  stale: boolean;
  knownPlans: string[];
  /** The stored USD equivalent of the record's payment (NBP rate of the day before it). */
  paidUsd?: { usd: number; day: string | null; amount: string; currency: string } | null;
  providers: string[];
  accountLabel: (id: string, forProvider?: string) => string;
  onPatch: (values: Partial<DraftBase>) => void;
  onPatchPlan: (values: Partial<{ plan: string; amount: string; currency: string; renewal: string; cycleMonths: string }>) => void;
  onCancel: () => void;
  onPreview: () => void;
  onSave: () => void;
  /** Saves the edit and ends the earlier declared periods it runs into at its start. */
  onSaveEndingEarlier: () => void;
  /** Ends the draft at a later period's start and checks it again. */
  onEndBefore: (at: string) => void;
  onReload: () => void;
  children?: ReactNode;
  onRemove?: () => void;
  removing: boolean;
  onConfirmRemove: () => void;
  onCancelRemove: () => void;
}) {
  const { t, locale } = useI18n();
  const accounts = groupAccountPeriods(view.accounts.filter((account) => account.provider === draft.provider), [], [])
    .map((group) => ({ id: group.aliases.includes(draft.account) ? draft.account : group.account, label: group.label }));
  const [customPlan, setCustomPlan] = useState(false);
  const canSave = !!preview && preview.errors.length === 0;
  const overlaps = preview && preview.errors.length > 0 ? overlapsOf(draft, view) : null;
  const offerEarlier = !!preview?.endEarlier && preview.endEarlier.errors.length === 0;
  // The server's overlap message carries raw instants; the readable list below replaces it when it names the rows.
  const readable = !!overlaps && overlaps.earlier.length + overlaps.later.length > 0;
  const errors = preview ? preview.errors.filter((message) => !(readable && message.startsWith(OVERLAP_ERROR))) : [];
  const listed = overlaps ? [...(offerEarlier ? [] : overlaps.earlier), ...overlaps.later] : [];
  const rowName = (row: DeclaredRow) => "plan" in row ? planName(row.plan, row.provider) : accountLabel(row.account, row.provider);
  return (
    <form className="account-periods-form" onSubmit={(event) => { event.preventDefault(); if (canSave && !busy && !removing) onSave(); }}>
      <fieldset disabled={busy}>
        <legend>{draft.kind === "plan" ? t("Plan and dates", "Plan i daty") : t("Account and dates", "Konto i daty")}</legend>
        <div className="account-periods-fields">
          {draft.kind === "plan" && !draft.lockAccount && providers.length > 1 && (
            <label>{t("Provider", "Dostawca")}<br />
              <Dropdown className="" value={draft.provider} onChange={(value) => onPatch({ provider: value, account: "", accountOther: "" })}
                options={providers.map((id) => ({ value: id, label: providerLabel(id) }))} />
            </label>
          )}
          {!draft.lockAccount && <><label>{t("Account", "Konto")}<br />
            <Dropdown className="" required value={draft.account} onChange={(value) => onPatch({ account: value })} options={[
              { value: "", label: t("Select an account", "Wybierz konto") },
              ...accounts.map((account) => ({ value: account.id, label: account.label })),
              { value: OTHER, label: t("other…", "inne…") },
            ]} />
          </label>
          {draft.account === OTHER && (
            <label>{t("Account identifier or e-mail", "Identyfikator konta lub e-mail")}<br />
              <input required className="mono" value={draft.accountOther} maxLength={200} onChange={(event) => onPatch({ accountOther: event.target.value })} />
            </label>
          )}
          </>}
          {draft.kind === "plan" && (
            <label>{t("Plan", "Plan")}<br />
              {customPlan ? <input required value={draft.plan} maxLength={120} onChange={(event) => onPatchPlan({ plan: event.target.value })} />
                : <Dropdown className="" required value={draft.plan} onChange={(value) => {
                  if (value === OTHER) { setCustomPlan(true); onPatchPlan({ plan: "" }); }
                  else onPatchPlan({ plan: value });
                }} options={[
                  { value: "", label: t("Choose a plan", "Wybierz plan") },
                  ...knownPlans.map((plan) => ({ value: plan, label: planName(plan, draft.provider) })),
                  { value: OTHER, label: t("Other plan…", "Inny plan…") },
                ]} />}
            </label>
          )}
          <label className="account-periods-date">{t("From", "Od")}<br />
            <input required type="datetime-local" className="mono" value={draft.from} title={utcTitle(draft.from)} onChange={(event) => onPatch({ from: event.target.value })} />
          </label>
          <label className="account-periods-date">{t("Until", "Do")}<HelpDot label={t("Until", "Do")}>{t(
            "Leave Until blank if it still applies. Times on this computer's clock.", "Zostaw „Do” puste, jeśli okres nadal trwa. Godziny według zegara tego komputera.")}</HelpDot><br />
            <input type="datetime-local" className="mono" value={draft.until} title={utcTitle(draft.until)} onChange={(event) => onPatch({ until: event.target.value })} />
          </label>
        </div>
        {draft.kind === "plan" && draft.plan !== NO_PLAN && <div className="account-periods-fields">
          <label className="account-periods-date">{t("Renewal day", "Dzień odnowienia")}<HelpDot label={t("Renewal day", "Dzień odnowienia")}>{t(
            "Empty: the start of the period.", "Puste: początek okresu.")}</HelpDot><br />
            <input type="datetime-local" className="mono" value={draft.renewal ?? ""} title={utcTitle(draft.renewal)} onChange={(event) => onPatchPlan({ renewal: event.target.value })} />
          </label>
          <label className="account-periods-date">{t("Billing period", "Okres rozliczeniowy")}<br />
            <Dropdown className="" value={draft.cycleMonths ?? "1"} onChange={(value) => onPatchPlan({ cycleMonths: value })} options={[
              { value: "1", label: t("Monthly", "Miesięczny") },
              { value: "12", label: t("Annual", "Roczny") },
            ]} />
          </label>
        </div>}
        <details className="account-periods-form-extra"><summary>{draft.kind === "plan" ? t("Payment, note and source", "Płatność, notatka i podstawa korekty") : t("Note and source", "Notatka i podstawa korekty")}</summary>
          <div className="account-periods-fields">
          {draft.kind === "plan" && <>
            <label>{t("Amount", "Kwota")}<br />
              <input type="number" min="0" step="0.01" className="mono" value={draft.amount} onChange={(event) => onPatchPlan({ amount: event.target.value })} />
              {/* Only while the fields still hold the saved payment: an edited amount has no rate yet. */}
              {paidUsd && Number(draft.amount).toFixed(2) === paidUsd.amount && draft.currency.trim().toUpperCase() === paidUsd.currency.toUpperCase() && <small className="account-periods-local mono" title={t("NBP mid rate of the day before the payment", "Średni kurs NBP z dnia przed płatnością")}>
                ≈ {cycleMoney(paidUsd.usd, "USD", locale)}{paidUsd.day ? ` · NBP ${paidUsd.day}` : ""}</small>}
            </label>
            <label>{t("Currency", "Waluta")}<br />
              <input className="mono" value={draft.currency} maxLength={3} size={4} onChange={(event) => onPatchPlan({ currency: event.target.value })} />
            </label>
          </>}
          <label>{t("Source of this correction", "Podstawa korekty")}<br />
            <input required className="mono" value={draft.evidence} maxLength={120} onChange={(event) => onPatch({ evidence: event.target.value })} />
          </label>
          <label>{t("Note", "Notatka")}<br />
            <input value={draft.note} maxLength={400} onChange={(event) => onPatch({ note: event.target.value })} />
          </label>
        </div>
        </details>
        {children}
        {preview && (
          <div role="status" className="account-periods-preview">
            {preview.events && (
              <p>
                {t("Events of this source in the range", "Zdarzenia tego źródła w zakresie")}: <span className="mono">{preview.events.calls.toLocaleString()}</span>
                {" "}({preview.events.days.toLocaleString()} {t("days", "dni")}
                {preview.events.first ? <>, <span className="mono">{preview.events.first} → {preview.events.last ?? "—"}</span></> : null})
              </p>
            )}
            <p>
              {preview.overrides.length === 0
                ? t("This change does not contradict saved readings.", "Ta zmiana nie przeczy zapisanym odczytom.")
                : t("Your correction takes precedence over these readings:", "Twoja korekta zastąpi w tych datach następujące odczyty:")}
            </p>
            {preview.overrides.length > 0 && (
              <ul className="mono">
                {preview.overrides.map((override) => (
                  <li key={override.id}>{formatStamp(override.from)} → {override.until === null ? t("ongoing", "trwa") : formatStamp(override.until)}: {override.value}</li>
                ))}
              </ul>
            )}
            {preview.billing && (
              <p>{t("Only this account's billing periods are recalculated, from", "Przeliczone zostaną tylko okresy rozliczeniowe tego konta, od")}{" "}
                <span className="mono">{formatStamp(preview.billing.from)}</span>.</p>
            )}
            {errors.length > 0 && (
              <ul className="account-periods-warn">{errors.map((message) => <li key={message}>{message}</li>)}</ul>
            )}
            {listed.length > 0 && (
              <div className="account-periods-end-earlier">
                <p className="account-periods-warn">{t("These dates overlap another period of yours:", "Te daty nakładają się na inny Twój okres:")}</p>
                <ul className="mono">{listed.map((row) => <li key={row.id}>
                  {rowName(row)} · {stampAt(row.from)} → {row.until === null ? t("ongoing", "trwa") : stampAt(row.until)}
                </li>)}</ul>
                {overlaps!.later[0] && <GhostButton disabled={busy || removing} emphasis onClick={() => onEndBefore(overlaps!.later[0]!.from)}>
                  {t("End before the next period", "Zakończ przed następnym okresem")} ({stampAt(overlaps!.later[0]!.from)})
                </GhostButton>}
              </div>
            )}
            {preview.errors.length > 0 && preview.endEarlier && preview.endEarlier.errors.length === 0 && (
              <div className="account-periods-end-earlier">
                <p>{t("These earlier periods still run when this one starts. The change can end them at its start in the same save:",
                  "Te wcześniejsze okresy trwają jeszcze w chwili rozpoczęcia tego. Zmiana może je zakończyć w tej chwili w tym samym zapisie:")}</p>
                <ul className="mono">{preview.endEarlier.rows.map((row) => <li key={`${row.value}|${row.from}`}>
                  {draft.kind === "plan" ? planName(row.value, draft.provider) : accountLabel(row.value, draft.provider)} · {stampAt(row.from)} → {row.until === null ? t("ongoing", "trwa") : stampAt(row.until)}
                  {" "}⇒ {stampAt(toInstant(draft.from))}
                </li>)}</ul>
                <GhostButton disabled={busy || removing} emphasis onClick={onSaveEndingEarlier}>
                  {t("End them at this start and save", "Zakończ je w chwili rozpoczęcia i zapisz")}
                </GhostButton>
              </div>
            )}
          </div>
        )}
        {error && <p role="alert" className="account-periods-warn">
          {error}
          {stale && <> <GhostButton onClick={onReload}>{t("Refresh", "Odśwież")}</GhostButton></>}
        </p>}
        {removing && <div role="alert" className="account-periods-preview">
          <p>{t("Remove your correction? Original readings will apply again; missing periods remain unknown.", "Usunąć Twoją korektę? Znów będą obowiązywać odczyty, a brakujące okresy pozostaną nieustalone.")}</p>
          <GhostButton disabled={busy} onClick={onConfirmRemove}>{t("Remove this period", "Usuń ten okres")}</GhostButton>{" "}
          <GhostButton disabled={busy} onClick={onCancelRemove}>{t("Keep correction", "Zachowaj korektę")}</GhostButton>
        </div>}
        <div className="account-periods-actions">
          <GhostButton onClick={onPreview} disabled={busy || removing} emphasis={!canSave}>{t("Preview", "Podgląd")}</GhostButton>
          <GhostButton type="submit" disabled={busy || !canSave || removing} emphasis={canSave}
            title={canSave ? undefined : t("Check the impact before saving.", "Sprawdź skutki zmiany przed zapisem.")}>{busy ? t("Saving…", "Zapisywanie…") : t("Save", "Zapisz")}</GhostButton>
          {onRemove && <GhostButton onClick={onRemove} disabled={busy || removing}>{t("Remove correction", "Usuń korektę")}</GhostButton>}
          <GhostButton onClick={onCancel} disabled={busy}>{t("Cancel", "Anuluj")}</GhostButton>
        </div>
      </fieldset>
    </form>
  );
}
