import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AccountPeriodsView, PeriodSource, PlanPeriodRow } from "../../shared/account-periods";
import type { PlanPriceCoverageSubject, PlanPriceGap } from "../../shared/plan-price-coverage";
import { useI18n } from "../lib/i18n";
import { polishPlural } from "../lib/mixFormat";
import { usd } from "../lib/format";
import { Disclosure, Fact, FactNote, Facts, GhostButton } from "./ui";
import { useFillHeight } from "../lib/useFillHeight";
import type { TimelineRow } from "./AccountPeriodsSettings";
import { AccountHistoryTimeline, effectivePlanRows, planBreaks, planName, planSegments, PlanStrip, type DetailTab, type PeriodShift, type PlanPeriodSelection } from "./AccountHistoryTimeline";
import { canonicalPeriodPlan, respectDeclaredEnds } from "../../shared/period-end";
import type { BillingCycle, BillingCyclesAccount, BillingCyclesPending } from "../../shared/billing-cycles";

/** Provider spellings mapped to the catalog; unknown labels remain visible. */
export const planDisplay = canonicalPeriodPlan;
const pad2 = (n: number) => String(n).padStart(2, "0");
/** An instant on this computer's clock as "YYYY-MM-DD HH:mm", the clock the period editor's fields use. */
export function localStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
/** A day-only value stays a day; an instant is shown on this computer's clock. */
export function formatStamp(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? localStamp(ms) : value;
}

export interface SourceTimeline { source: PeriodSource; rows: TimelineRow[] }
interface AccountGroup {
  key: string;
  provider: string;
  account: string;
  aliases: string[];
  label: string;
  plans: PlanPeriodRow[];
  timelines: SourceTimeline[];
}
const groupKey = (provider: string, account: string) => JSON.stringify([provider, account]);
const start = (value: string) => Date.parse(value);
const end = (value: string | null) => value === null ? Infinity : start(value);
export const periodKey = (row: { id: number; from: string; until: string | null }) => JSON.stringify([row.id, row.from, row.until]);

/** Split observations around declarations for display, retaining each original row for edits. */
export function effectivePeriodRows<T extends { from: string; until: string | null; origin: "observed" | "declared" }>(rows: T[]) {
  const bounded = respectDeclaredEnds(rows, () => "", row => {
    const period = row as T & { plan?: string; account?: string };
    return period.plan ? planDisplay(period.plan) : period.account ?? "";
  });
  const declarations = rows.filter((row) => row.origin === "declared");
  return bounded.flatMap((boundedRow, index) => {
    const row = rows[index]!;
    let parts = [{ row, from: boundedRow.from, until: boundedRow.until }];
    if (row.origin === "observed") for (const declared of declarations) {
      parts = parts.flatMap((part) => {
        if (end(part.until) <= start(declared.from) || start(part.from) >= end(declared.until)) return [part];
        const remaining: typeof parts = [];
        if (start(part.from) < start(declared.from)) remaining.push({ ...part, until: declared.from });
        if (end(part.until) > end(declared.until)) remaining.push({ ...part, from: declared.until! });
        return remaining;
      });
    }
    return parts;
  }).sort((a, b) => start(a.from) - start(b.from));
}
const place = (source: PeriodSource) => source.machine
  ? `${source.machine}${source.profile ? ` · ${source.profile}` : ""}` : source.key;

/** Recognized e-mail joins profile-specific aliases; arbitrary labels never merge identities. */
export function groupAccountPeriods(accounts: AccountPeriodsView["accounts"], timelines: SourceTimeline[], plans: PlanPeriodRow[]) {
  const groups = new Map<string, AccountGroup>();
  function ensure(provider: string, account: string) {
    const known = accounts.find((item) => item.provider === provider && item.id === account);
    const email = known?.label.trim().toLowerCase();
    const key = groupKey(provider, email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? `email:${email}` : `id:${account}`);
    if (!groups.has(key)) groups.set(key, {
      key, provider, account,
      label: known?.label ?? account, aliases: [], plans: [], timelines: [],
    });
    const group = groups.get(key)!;
    if (!group.aliases.includes(account)) group.aliases.push(account);
    if (known?.current) group.account = account;
    return group;
  }
  for (const account of accounts) ensure(account.provider, account.id);
  for (const plan of plans) ensure(plan.provider, plan.account).plans.push(plan);
  for (const timeline of timelines) {
    for (const row of timeline.rows) {
      if (!row.period) continue;
      const group = ensure(row.provider, row.period.account);
      let source = group.timelines.find((entry) => entry.source.key === timeline.source.key);
      if (!source) { source = { source: timeline.source, rows: [] }; group.timelines.push(source); }
      source.rows.push(row);
    }
  }
  return [...groups.values()];
}

/** Accounts with no plan and no computer period only list their names; they are folded (UI audit, Settings). */
export function foldEmptyAccounts<T extends { plans: unknown[]; timelines: unknown[] }>(groups: T[]): { active: T[]; empty: T[] } {
  const active = groups.filter((group) => group.plans.length > 0 || group.timelines.length > 0);
  return { active, empty: groups.filter((group) => !active.includes(group)) };
}

/** Declarations override observations only where their dates cover the present. */
export function currentPlan(plans: PlanPeriodRow[], now: number): string | null {
  const active = [...new Set(plans.map(row => row.account))].flatMap(account =>
    effectivePeriodRows(plans.filter(row => row.account === account)))
    .filter(part => start(part.from) <= now && now < end(part.until)).map(part => part.row);
  const effective = [...new Set(active.map((row) => row.account))].flatMap((account) => {
    const rows = active.filter((row) => row.account === account);
    const declared = rows.filter((row) => row.origin === "declared");
    return declared.length ? declared : rows;
  });
  const labels = [...new Set(effective.map((row) => planDisplay(row.plan)))];
  return labels.length === 1 ? labels[0]! : null;
}

/** Only confirmed source/account overlaps; an unknown interval never inherits a nearby account. */
export function placesInPlan(timelines: SourceTimeline[], plan: Pick<PlanPeriodRow, "provider" | "account" | "from" | "until">, aliases: string[] = [plan.account]) {
  return timelines.flatMap(({ source, rows }) => rows.flatMap((row) => {
    const from = Math.max(start(row.from), start(plan.from));
    const until = Math.min(end(row.until), end(plan.until));
    if (!row.period || row.provider !== plan.provider || !aliases.includes(row.period.account) || from >= until) return [];
    return [{ key: row.key, source, from: new Date(from).toISOString(), until: until === Infinity ? null : new Date(until).toISOString() }];
  }));
}

/** Plan price coverage as the Settings tab shows it; `subjects` is null while it is read. */
export interface PriceCoverage { subjects: PlanPriceCoverageSubject[] | null; error: string | null }
/** The priced subscriptions of one account (its own id and its billing variants), matched through the group's aliases. */
export function coverageOf(coverage: PriceCoverage | undefined, provider: string, aliases: string[]): PlanPriceCoverageSubject[] {
  return coverage?.subjects?.filter((subject) => subject.provider === provider && aliases.includes(subject.account)) ?? [];
}
/** A subscription whose missing price a plan period can fill: not a usage-billed pool, not traffic without an account. */
export const fillable = (subject: PlanPriceCoverageSubject) => !subject.usage_based && !subject.unattributed;
const gapDays = (subject: PlanPriceCoverageSubject) => subject.gaps.reduce((sum, gap) => sum + gap.days, 0);

/** An account of the rail as the other Settings sections address it: its provider and every id it was seen under. */
export interface RailAccount { provider: string; account: string; aliases: string[]; label: string }
const PROVIDER_OF_VENDOR: Record<string, string> = { openai: "codex", anthropic: "claude", google: "gemini", xai: "grok", zai: "glm" };
const providerOfVendor = (vendor: string) => {
  const name = vendor.trim().toLowerCase();
  return PROVIDER_OF_VENDOR[name] ?? name;
};
/**
 * Whether a subscription (an accounts.json id) is this account's. A billing variant `id::mode` belongs to `id`,
 * as the plan price coverage reads it; the e-mail is not used, since one e-mail can sign in to two accounts' variants.
 */
export function holdsSubscription(account: Pick<RailAccount, "provider" | "aliases">, subscription: string, vendor?: string | null): boolean {
  if (vendor && providerOfVendor(vendor) !== account.provider) return false;
  return account.aliases.includes(subscription.split("::")[0]!);
}

/** Settings' tabs for one account after its history tables, or a note saying why there are none. */
export interface AccountSectionsSpec { tabs: DetailTab[]; note?: ReactNode }
/** A tab a link asked for; `seq` changes on every request so asking for the same tab again still shows it. */
export interface SectionRequest { key: string; seq: number }
/** Accounts without a plan listed per provider before the rest of them fold. */
const NO_PLAN_SHOWN = 2;

/**
 * The server's reason the account's cycles are stale, over its aliases: one that moves dates over figures only, then
 * the earliest start (a start-less change reaches every cycle).
 */
function serverPending(entries: readonly BillingCyclesAccount[]): BillingCyclesPending | null {
  const moves = (pending: BillingCyclesPending) => pending.reason !== "figures";
  const at = (pending: BillingCyclesPending) => pending.from === null ? -Infinity : Date.parse(pending.from);
  return entries.filter((entry) => entry.stale).map((entry) => entry.pending).filter((pending): pending is BillingCyclesPending => !!pending)
    .sort((a, b) => Number(moves(b)) - Number(moves(a)) || at(a) - at(b))[0] ?? null;
}

export function AccountPeriodGroups({ accounts, timelines, plans, providers, providerLabel, renderSources, onPlanPeriod, onSourcePeriod, addPlan, editing, focus = null, priceCoverage, onPriceGap, selectAccount = null, accountSections, requestedSection = null, allAccountsSections, billingCycles, billingPending = null, onCycle, onRemovePlan }: {
  accounts: AccountPeriodsView["accounts"]; timelines: SourceTimeline[]; plans: PlanPeriodRow[]; providers: string[];
  providerLabel: (provider: string) => string;
  renderSources: (timelines: SourceTimeline[], unknown?: boolean) => ReactNode;
  onPlanPeriod: (selection: PlanPeriodSelection, shift?: PeriodShift) => void;
  onSourcePeriod: (source: PeriodSource, row: TimelineRow, shift?: PeriodShift) => void;
  addPlan: (provider: string, account: string) => void;
  editing: boolean;
  /** One account's history only (the Overview drawer): no account list and no unassigned sources. */
  focus?: string | null;
  /** Settings only: which days of each priced subscription lack a plan price. */
  priceCoverage?: PriceCoverage;
  onPriceGap?: (subject: PlanPriceCoverageSubject, gap: PlanPriceGap) => void;
  /** Settings only: a subscription id (or e-mail) a link arrived for; its account is chosen in the rail. */
  selectAccount?: string | null;
  /** Settings only: the selected account's further sections, as tabs of the switcher under its timeline. */
  accountSections?: (account: RailAccount) => AccountSectionsSpec;
  /** Settings only: the switcher tab a link asked for. */
  requestedSection?: SectionRequest | null;
  /** Settings only: what "All accounts" adds under the histories, given every account of the list. */
  allAccountsSections?: (accounts: RailAccount[]) => ReactNode;
  /** Settings only: every account's billing cycles (null while read) and the editor a cycle opens. */
  billingCycles?: BillingCyclesAccount[] | null;
  /** The account and start a save has just sent to the billing producer; its later cycles show as being recalculated. */
  billingPending?: { provider: string; account: string; from: string } | null;
  onCycle?: (account: { provider: string; account: string; aliases: string[] }, cycle: BillingCycle) => void;
  /** Opens one declared plan period with its removal to confirm. */
  onRemovePlan?: (selection: PlanPeriodSelection) => void;
}) {
  const { t } = useI18n();
  const [now] = useState(Date.now);
  const status = (group: AccountGroup) => currentPlan(group.plans, now) ? 0 : group.plans.length ? 1 : 2;
  const groups = groupAccountPeriods(accounts, timelines, plans)
    .sort((a, b) => a.provider.localeCompare(b.provider) || status(a) - status(b) || a.label.localeCompare(b.label));
  const wanted = selectAccount
    ? groups.find((group) => holdsSubscription(group, selectAccount) || group.label.toLowerCase() === selectAccount.toLowerCase())?.key ?? null
    : null;
  const [selection, setSelection] = useState<string | null>(wanted);
  const [mode, setMode] = useState<"one" | "all">("one");
  useEffect(() => { if (wanted) { setSelection(wanted); setMode("one"); } }, [wanted]);
  const [showEmpty, setShowEmpty] = useState(false);
  const [openNoPlan, setOpenNoPlan] = useState<ReadonlySet<string>>(() => new Set());
  // The open tab under the selected account's timeline; a link's request opens its tab and brings it into view.
  const [detail, setDetail] = useState<string | null>(requestedSection?.key ?? null);
  const [reveal, setReveal] = useState(false);
  useEffect(() => { if (requestedSection) { setDetail(requestedSection.key); setReveal(true); setMode("one"); } }, [requestedSection?.seq]);
  // The rail and the account scroll on their own (user, 2026-10-12): the workspace takes the window's height below its top.
  const workspace = useRef<HTMLDivElement>(null);
  const workspaceHeight = useFillHeight(workspace, [focus]);
  const { active, empty } = foldEmptyAccounts(groups);
  const unknown = timelines.map(({ source, rows }) => ({ source, rows: rows.filter((row) => !row.period) })).filter(({ rows }) => rows.length > 0);
  const unknownCount = unknown.reduce((count, { rows }) => count + rows.length, 0);
  const selected = groups.find((group) => group.key === selection) ?? [...active].sort((a, b) => b.plans.length - a.plans.length)[0] ?? groups[0];
  const showUnknown = selection === "unknown" || !selected;
  /** A plan history with nothing covering today means the subscription has ended, not that its plan is unknown. */
  const planLabel = (group: AccountGroup) => {
    const active = currentPlan(group.plans, now);
    if (active) return planName(active, group.provider);
    if (effectivePlanRows(group.plans).some((part) => start(part.from) <= now && now < end(part.until))) return t("Conflicting readings", "Sprzeczne odczyty");
    return group.plans.length ? t("Inactive", "Nieaktywny") : t("Plan not established", "Plan nieustalony");
  };
  const day = (ms: number) => new Date(ms).toLocaleDateString(t("en-GB", "pl-PL"), { day: "2-digit", month: "2-digit", timeZone: "UTC" });
  /** When the current plan began (null without one). */
  const currentSince = (group: AccountGroup) => {
    const current = currentPlan(group.plans, now) ? planSegments(group.plans, -Infinity, now + 1).find((segment) => segment.from <= now && now < segment.until) : undefined;
    return current && Number.isFinite(current.from) ? current.from : null;
  };
  /** The computers that use the account now. */
  const machinesNow = (group: AccountGroup) => [...new Set(group.timelines.flatMap(({ source, rows }) =>
    rows.some((row) => Date.parse(row.from) <= now && now < (row.until ? Date.parse(row.until) : Infinity)) ? [source.machine ?? source.key] : []))];
  const computers = (count: number) => `${count} ${t(count === 1 ? "computer" : "computers", polishPlural(count, "komputer", "komputery", "komputerów"))}`;
  const dayOf = (value: string) => day(Date.parse(`${value}T00:00:00Z`));
  const fullDay = (value: string) => new Date(Date.parse(`${value}T00:00:00Z`)).toLocaleDateString(t("en-GB", "pl-PL"), { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
  const dayCount = (days: number) => {
    const shown = Math.round(days * 10) / 10;
    return `${shown.toLocaleString(t("en-GB", "pl-PL"))} ${t(shown === 1 ? "day" : "days", polishPlural(shown, "dzień", "dni", "dni"))}`;
  };
  const gapCount = (count: number) => `${count} ${t(count === 1 ? "gap" : "gaps", polishPlural(count, "luka", "luki", "luk"))}`;
  /** Each gap opens the plan editor on its dates; a usage-billed pool or traffic without an account has nothing to fill. */
  const gapButtons = (subject: PlanPriceCoverageSubject) => subject.gaps.map((gap, index) => <span key={gap.from_ts}>
    {index > 0 && " · "}
    {gap.rate_pending
      ? <span title={t("NBP rate pending: fetched in the background", "kurs NBP w drodze: pobierany w tle")}>{dayOf(gap.from)}–{dayOf(gap.until)}</span>
      : fillable(subject) && onPriceGap
      ? <button type="button" className="account-periods-expand" disabled={editing} title={`${formatStamp(gap.from_ts)} → ${formatStamp(gap.until_ts)}`}
        onClick={() => onPriceGap(subject, gap)}>{dayOf(gap.from)}–{dayOf(gap.until)}</button>
      : <span>{dayOf(gap.from)}–{dayOf(gap.until)}</span>}
  </span>);
  /** One labelled fact of the account's header: a short value and, under it, what it rests on. */
  const fact = (key: string, label: ReactNode, value: ReactNode, notes?: ReactNode, tone?: "warn") =>
    <Fact key={key} id={key} label={label} value={value} notes={notes} tone={tone} />;
  const note = (content: ReactNode, key?: string) => <FactNote key={key}>{content}</FactNote>;
  /** Where a known plan cost comes from, summed by source: the price card's tooltip. */
  const priceSources = (subject: PlanPriceCoverageSubject) => {
    const sums = new Map<string, number>();
    for (const piece of subject.pieces) {
      if (piece.usd === null) continue;
      const source = piece.cycle
        ? piece.cycle.source === "declared" ? t("payments", "płatności")
          : piece.cycle.source === "repeated" ? t("repeated payments", "powtórzone płatności") : t("catalog (cycles)", "cennik (cykle)")
        : piece.source === "rate-card" ? t("rate card", "karta stawek") : t("catalog", "cennik");
      sums.set(source, (sums.get(source) ?? 0) + piece.usd);
    }
    return [...sums].map(([source, amount]) => `${source} ${usd(amount)}`).join(" · ");
  };
  /** Whether the plan cost the Projects screen shows is known over the account's whole traffic span. */
  const priceFact = (group: AccountGroup) => {
    if (!priceCoverage) return null;
    const label = t("Plan price", "Cena planu");
    if (priceCoverage.subjects === null) return fact("price", label, priceCoverage.error ? t("could not be checked", "nie udało się sprawdzić") : t("checking…", "sprawdzam…"),
      priceCoverage.error ? note(priceCoverage.error) : undefined);
    const subjects = coverageOf(priceCoverage, group.provider, group.aliases);
    if (subjects.length === 0) return null;
    const named = (subject: PlanPriceCoverageSubject) => subjects.length > 1 || subject.id !== subject.account;
    const name = (subject: PlanPriceCoverageSubject) => `${subject.id !== subject.account && subject.label ? `${subject.label} ` : ""}${subject.id}`;
    const summary = (subject: PlanPriceCoverageSubject): { value: ReactNode; detail: ReactNode; warn: boolean } => {
      if (subject.usage_based) return { value: t("usage-based", "za zużycie"), warn: false,
        detail: t("usage-based billing — no flat monthly price", "rozliczenie za zużycie — brak stałej ceny miesięcznej") };
      if (subject.usd !== null) return { value: <span className="ui-figure" title={priceSources(subject) || undefined}>{usd(subject.usd)}</span>, warn: false,
        detail: <>{t("known for the whole active period", "znana za cały okres aktywności")}{subject.first && subject.last ? ` (${fullDay(subject.first)}–${fullDay(subject.last)})` : ""}</> };
      return { value: t("unknown", "nieznana"), warn: true,
        detail: <span title={t("Projects show “no plan price” for this account because no priced plan period covers these days.",
          "Projekty pokazują „brak ceny planu” dla tego konta, bo tych dni nie obejmuje żaden okres planu z ceną.")}>
          {dayCount(gapDays(subject))} {t("of activity without a price", "aktywności bez ceny")}: {gapButtons(subject)}</span> };
    };
    const main = subjects.find((subject) => fillable(subject)) ?? subjects[0]!;
    const first = summary(main);
    return fact("price", <>{label}{named(main) ? <> · <span className="mono">{name(main)}</span></> : null}</>, first.value, <>
      {note(first.detail, "main")}
      {subjects.filter((subject) => subject !== main).map((subject) => {
        const other = summary(subject);
        return note(<><span className="mono">{name(subject)}</span>: {other.warn ? <>{t("unknown", "nieznana")} — {other.detail}</> : other.detail}{subject.usd !== null && !subject.usage_based ? <> · {usd(subject.usd)}</> : null}</>, subject.id);
      })}
    </>, first.warn ? "warn" : undefined);
  };
  const history = (group: AccountGroup, withSections = false) => {
    const breaks = planBreaks(group.plans, now);
    const unpriced = coverageOf(priceCoverage, group.provider, group.aliases).filter(fillable)
      .flatMap((subject) => subject.gaps.filter((gap) => !gap.rate_pending).map((gap) => ({ account: subject.account, from: gap.from_ts, until: gap.until_ts })));
    // The cycles of every id the account was seen under (stored lower-case).
    const ids = group.aliases.map((alias) => alias.toLowerCase());
    const owned = (billingCycles ?? []).filter((entry) => entry.provider === group.provider && ids.includes(entry.account));
    const cycles = owned.flatMap((entry) => entry.cycles).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const pendingHere = !!billingPending && billingPending.provider === group.provider && ids.includes(billingPending.account.toLowerCase());
    const machines = machinesNow(group);
    const since = currentSince(group);
    const spec = withSections ? accountSections?.(railAccount(group)) : undefined;
    // Only the selected account keeps the switcher's tab here; in "All accounts" each timeline keeps its own.
    const keepsTab = withSections || focus != null;
    const switcher = keepsTab ? { detail, onDetail: setDetail, reveal, onRevealed: () => setReveal(false) } : {};
    return <section className="account-periods-history" key={group.key} aria-label={group.label}>
      <div className="ui-sheet-head">
        <div><span className="ui-sheet-eyebrow">{providerLabel(group.provider)}</span><h3>{group.label}</h3></div>
        <GhostButton disabled={editing} onClick={() => addPlan(group.provider, group.account)}>+ {t("Add plan period", "Dodaj okres planu")}</GhostButton>
      </div>
      <Facts>
        {group.plans.length > 0 && fact("plan", t("Plan now", "Plan teraz"), <strong>{planLabel(group)}</strong>,
          since !== null ? note(<>{t("since", "od")} {formatStamp(new Date(since).toISOString())}</>) : undefined)}
        {fact("computers", t("Computers now", "Komputery teraz"), <strong>{machines.length}</strong>, machines.length ? note(machines.join(", ")) : undefined)}
        {priceFact(group)}
        {breaks.length > 0 && fact("breaks", t("Breaks without a plan", "Przerwy bez planu"), <>
          <strong>{breaks.length}</strong>
          {keepsTab && group.plans.length > 0 && <button type="button" className="account-periods-expand" onClick={() => { setDetail("subscription"); setReveal(true); }}>
            {t("show in the table →", "pokaż w tabeli →")}</button>}
        </>, note(breaks.map((gap) => `${day(gap.from)}–${day(gap.until)}`).join(" · ")), "warn")}
      </Facts>
      <AccountHistoryTimeline key={group.key} plans={group.plans} timelines={group.timelines}
        provider={group.provider} account={group.account} aliases={group.aliases}
        onPlanPeriod={onPlanPeriod} onSourcePeriod={onSourcePeriod} editing={editing} {...(onRemovePlan ? { onRemovePlan } : {})}
        sections={spec?.tabs} {...switcher}
        {...(priceCoverage ? { priceGaps: unpriced } : {})}
        {...(billingCycles && onCycle ? { cycles, cyclesStale: owned.some((entry) => entry.stale) || pendingHere,
          cyclesPendingFrom: pendingHere ? billingPending!.from : null, cyclesPending: serverPending(owned),
          // The cycle's own id among the account's aliases (stored lower-case).
          onCycle: (cycle: BillingCycle) => {
            const id = owned.find((entry) => entry.cycles.includes(cycle))?.account;
            const account = group.aliases.find((alias) => alias.toLowerCase() === id) ?? group.account;
            onCycle({ provider: group.provider, account, aliases: group.aliases }, cycle);
          } } : {})} />
      {spec?.note}
    </section>;
  };
  const railAccount = (group: AccountGroup): RailAccount => ({ provider: group.provider, account: group.account, aliases: group.aliases, label: group.label });
  if (focus != null) {
    const group = groups.find((candidate) => candidate.aliases.includes(focus));
    return group ? history(group)
      : <p className="account-periods-note">{t("No periods are recorded for this account yet.", "Dla tego konta nie ma jeszcze zapisanych okresów.")}</p>;
  }
  const unassigned = <section className="account-periods-history" id="account-history-unassigned" aria-label={t("History to complete", "Historia do uzupełnienia")}>
    <h3>{t("History to complete", "Historia do uzupełnienia")} · {unknownCount}</h3>
    <p className="account-periods-note">{t("We have history or gaps between readings on these computers, but no account period for these dates. Assign an account if you know.", "Mamy historię lub przerwy między odczytami na tych komputerach, ale nie ustaliliśmy konta dla tych dat. Przypisz je, jeśli wiesz.")}</p>
    {renderSources(unknown, true)}
  </section>;
  const isSelected = (group: AccountGroup) => mode === "one" && !showUnknown && selected?.key === group.key;
  /** Name and the price-gap flag on the first line; the plan now, since when and on how many computers, and its 90-day strip on the second. */
  const choice = (group: AccountGroup) => {
    const unpriced = coverageOf(priceCoverage, group.provider, group.aliases).filter((subject) => fillable(subject) && subject.usd === null);
    const gaps = unpriced.reduce((count, subject) => count + subject.gaps.length, 0);
    const since = currentSince(group), machines = machinesNow(group).length;
    return <button type="button" className={`account-periods-account-choice ui-rail-item${status(group) > 0 ? " is-quiet" : ""}`} aria-pressed={isSelected(group)}
      disabled={editing} onClick={() => { setSelection(group.key); setMode("one"); }}>
      <strong title={group.label}>{group.label}</strong>
      {unpriced.length > 0 ? <span className="account-periods-price-flag ui-rail-flag" title={`${t("No plan price", "Brak ceny planu")}: ${gapCount(gaps)}`}>{gapCount(gaps)}</span> : <span />}
      <span className="account-periods-choice-meta"><b>{planLabel(group)}</b>{since !== null && <> {t("since", "od")} {day(since)}</>}{machines > 0 && <> · {computers(machines)}</>}</span>
      {group.plans.length > 0 ? <PlanStrip plans={group.plans} provider={group.provider} now={now} /> : <span />}
    </button>;
  };
  const emptyList = empty.length > 0 && <div className="account-periods-empty">
    <Disclosure open={showEmpty} onToggle={() => setShowEmpty(!showEmpty)}>{t("Without periods", "Bez okresów")} · {empty.length}</Disclosure>
    {showEmpty && empty.map((group) => <div key={group.key}>{choice(group)}</div>)}
  </div>;
  const railProviders = [...new Set(active.map((group) => group.provider))];
  /** One provider's accounts; past the first few, accounts without a plan fold unless one of them is selected. */
  const providerList = (provider: string) => {
    const list = active.filter((group) => group.provider === provider);
    const withoutPlan = list.filter((group) => status(group) === 2);
    const folded = openNoPlan.has(provider) || withoutPlan.slice(NO_PLAN_SHOWN).some(isSelected) ? [] : withoutPlan.slice(NO_PLAN_SHOWN);
    const toggle = () => setOpenNoPlan((open) => { const next = new Set(open); if (next.has(provider)) next.delete(provider); else next.add(provider); return next; });
    return <div className="ui-rail-group" key={provider}>
      <div className="ui-rail-heading"><i style={{ background: `var(--${provider}, var(--line2))` }} />{providerLabel(provider)} <span>· {list.length}</span></div>
      {list.filter((group) => !folded.includes(group)).map((group) => <div key={group.key}>{choice(group)}</div>)}
      {withoutPlan.length > NO_PLAN_SHOWN && <div className="account-periods-more">
        <Disclosure open={folded.length === 0} onToggle={toggle}>{folded.length
          ? t("{0} more without a plan", `jeszcze ${folded.length} ${polishPlural(folded.length, "konto", "konta", "kont")} bez planu`, [folded.length])
          : t("Fold accounts without a plan", "Zwiń konta bez planu")}</Disclosure>
      </div>}
    </div>;
  };
  return <div className="account-periods-workspace ui-workspace" ref={workspace} style={workspaceHeight ? { height: workspaceHeight } : undefined}>
    <nav className="account-periods-accounts ui-workspace-rail" aria-label={t("Choose an account", "Wybierz konto")}>
      <button type="button" className="account-periods-account-choice ui-rail-item account-periods-all-choice" aria-pressed={mode === "all"} disabled={editing}
        onClick={() => setMode("all")}>
        <strong>{t("All accounts — overview", "Wszystkie konta — przegląd")}</strong><span>{active.length} →</span>
      </button>
      {railProviders.map(providerList)}
      {unknownCount > 0 && <button type="button" className="account-periods-account-choice ui-rail-item account-periods-warn"
        aria-pressed={mode === "one" && showUnknown} disabled={editing} onClick={() => { setSelection("unknown"); setMode("one"); }}>
        <strong>{t("To complete", "Do uzupełnienia")} · {unknownCount}</strong><span /><span>{t("History without an account", "Historia bez ustalonego konta")}</span>
      </button>}
      {emptyList}
    </nav>
    <div className="account-periods-histories ui-workspace-sheet">
      {/* With nothing to list there is no account header, so the only add button lives here. */}
      {groups.length === 0 && providers[0] && <GhostButton disabled={editing} onClick={() => addPlan(providers[0]!, "")}>+ {t("Add plan history", "Dodaj historię planu")}</GhostButton>}
      {mode === "all" ? <>{active.map((group) => history(group))}{unknownCount > 0 && unassigned}{allAccountsSections?.(groups.map(railAccount))}</>
        : showUnknown ? unassigned : selected && history(selected, true)}
    </div>
  </div>;
}
