import type { CreditPoolKind, CreditPoolsOfRange } from "../../shared/credit-pools";
import { type CreditFundedSums, type CreditWindowBasis } from "../../shared/credit-funded";
import { creditBasisOf, currentPointBasis, type CurrentPointBasis } from "./current-point-basis";
import type { ApiCycle } from "./api";
import { dayTime, usd } from "./format";
import { getLocale, translate } from "./i18n";
import { polishPlural } from "./mixFormat";
import { poolUsage, codexPoolEvidence, type PoolUsage, type PoolUnit, type FundedPoolEvidence } from "../../shared/pool-usage";

/**
 * Texts of an account's credits (docs/credit-pools-2026-10-09.md, mockup 2 accepted 10.10): the balance with its
 * conversion into windows, free resets and Claude dollar packages. Pools are those of the newest reading; "spent" is
 * their movement within one window. Balance conversions share the current prepared point basis; without a usable
 * sample the account keeps its bare balance.
 */

/** An account's credit state at its newest pool reading. */
export interface AccountCredits {
  /** `credits`: a Codex balance; `usd`: Claude dollar packages; `resets`: free resets only. */
  kind: "credits" | "usd" | "resets";
  readAt: string;
  /** Credit balance used by the existing window conversion. */
  remaining: number | null;
  pools: PoolUsage[];
  unlimited: boolean;
  /** The vendor's exact balance text (Codex). */
  exact: string | null;
  resets: { count: number; nextExpiry: string | null } | null;
  basis: CreditWindowBasis | null;
  /** Balance in windows of the basis, and its dollars at the basis's dollars per credit. */
  windows: number | null;
  usd: number | null;
}

export function accountCredits(range: CreditPoolsOfRange | null | undefined, basis?: CreditWindowBasis | null,
  evidence?: FundedPoolEvidence | null): AccountCredits | null {
  if (!range || range.pools.length === 0) return null;
  const balance = range.pools.find(pool => pool.unit === "credits");
  const money = range.pools.filter(pool => pool.unit === "usd");
  const resetPool = range.pools.find(pool => pool.unit === "resets");
  // An empty reset list is kept by the probe to show the last one going; it is no package by itself.
  const resets = resetPool && (resetPool.remaining ?? 0) > 0 ? { count: resetPool.remaining ?? 0, nextExpiry: resetPool.expires_at } : null;
  const base = { readAt: range.read_at, resets, basis: null, windows: null, usd: null, exact: null,
    pools: poolUsage(range, evidence), unlimited: false };
  if (balance) {
    const remaining = balance.remaining;
    const credits = basis && basis.credits > 0 ? basis : null;
    return { ...base, kind: "credits", remaining, unlimited: balance.unlimited, exact: balance.remaining_text, basis: credits,
      windows: credits && remaining != null && !balance.unlimited ? remaining / credits.credits : null,
      usd: credits?.usd != null && remaining != null && !balance.unlimited ? remaining * credits.usd / credits.credits : null };
  }
  if (money.length) {
    return { ...base, kind: "usd", remaining: null };
  }
  return resets ? { ...base, kind: "resets", remaining: null } : null;
}

export function poolFundingTitle(): string {
  return translate("Account pool spend and the valuation of funded calls are separate facts. Only explicit call evidence identifies funding. Missing evidence is not inferred from balance changes or API-eq.",
    "Wydatek puli konta i wycena wywołań z puli to osobne fakty. Finansowanie określa wyłącznie jawny dowód wywołania. Braków nie uzupełniamy na podstawie zmian salda ani API-eq.");
}

export interface PoolView {
  key: string;
  unit: PoolUnit;
  kind: CreditPoolKind | null;
  label: string;
  remaining: string;
  compactRemaining: string;
  compactSeparator: string;
  summary: string;
  aside: string | null;
  bar: number | null;
  title: string;
  observedSpend: string | null;
  fundedValue: string | null;
}

export const poolAmount = (value: number | null, unit: PoolUnit): string => value == null ? translate("not established", "nieustalone")
  : unit === "usd" ? usd(value) : `${amount(value)} ${translate("cr", "kr.")}`;

export function poolLabel(pool: Pick<PoolUsage, "kind" | "unit">): string {
  return pool.kind === "grant" ? translate("grant", "grant")
    : pool.kind === "purchase" ? translate("extra usage", "dodatkowe użycie")
    : pool.unit === "credits" ? translate("credits", "kredyty") : translate("dollar pool", "pula dolarowa");
}

function poolViews(account: AccountCredits): PoolView[] {
  return account.pools.map(pool => {
    const state = pool.state;
    const value = (n: number | null | undefined) => poolAmount(n ?? null, pool.unit);
    const summary = state && (state.granted != null || state.used != null) ? [
      pool.kind === "purchase" ? translate("limit {0}", `limit ${value(state.granted)}`, [value(state.granted)])
        : translate("granted {0}", `przyznano ${value(state.granted)}`, [value(state.granted)]),
      translate("used {0}", `zużyto ${value(state.used)}`, [value(state.used)]),
    ].join(" · ") : "";
    const aside = [state?.expires_at ? translate("expires {0}", `wygasa ${shortDate(state.expires_at)}`, [shortDate(state.expires_at)]) : null,
      pool.unit === "credits" && account.windows != null ? `${account.basis?.partial ? "≤ ≈" : "≈"} ${windowsText(account.windows)}` : null,
      pool.unit === "credits" && account.usd != null ? `≈ ${roundUsd(account.usd)}` : null].filter(Boolean).join(" · ");
    const share = state?.granted && state.remaining != null ? state.remaining / state.granted
      : pool.unit === "credits" && account.windows != null ? account.windows / BAR_WINDOWS : null;
    const remaining = state?.unlimited ? translate("unlimited", "bez limitu")
      : translate("left {0}", `zostało ${value(state?.remaining)}`, [value(state?.remaining)]);
    const bareBalance = pool.kind === "balance" && pool.unit === "credits";
    return { key: pool.key, kind: pool.kind, unit: pool.unit, label: poolLabel(pool),
      remaining,
      compactRemaining: bareBalance ? state?.unlimited ? translate("unlimited", "bez limitu")
        : state?.remaining == null ? "—" : creditsAmount(state.remaining) : remaining,
      compactSeparator: bareBalance ? " " : " · ",
      summary, aside: aside || null, bar: share != null ? Math.max(0, Math.min(1, share)) : null,
      title: [pool.key, creditsTitle(account)].join(" · "),
      observedSpend: pool.observedSpend != null ? translate("account spend this window {0}", `wydatek konta w tym oknie ${value(pool.observedSpend)}`, [value(pool.observedSpend)]) : null,
      fundedValue: pool.funded && pool.funded.calls > 0 ? translate("funded calls valuation {0}",
        `wycena wywołań z puli ${pool.funded.nativeUnpriced > 0 ? "≥ " : ""}${value(pool.funded.native)}`,
        [`${pool.funded.nativeUnpriced > 0 ? "≥ " : ""}${value(pool.funded.native)}`]) : null };
  });
}

/* ------------------------------------------------------------------------------------------ */
/* Words and numbers                                                                            */
/* ------------------------------------------------------------------------------------------ */

// The locale's no-break group separator as a plain space, as the earlier pool texts wrote it.
const space = (text: string) => text.replace(/[  ]/g, " ");
export function amount(value: number, fractionDigits = 2): string {
  return space(value.toLocaleString(getLocale(), { maximumFractionDigits: fractionDigits }));
}
/** Whole credits, grouped: "60 750". */
export const creditsAmount = (value: number) => amount(Math.round(value), 0);
/** The vendor's exact decimal text with the locale's grouping and separator, trailing zeros dropped. */
export function exactDecimal(text: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return text;
  const [, sign, whole, fraction = ""] = match;
  const grouped = space(BigInt(whole!).toLocaleString(getLocale()));
  const decimals = fraction.replace(/0+$/, "");
  const separator = (1.5).toLocaleString(getLocale()).charAt(1);
  return `${sign}${grouped}${decimals ? separator + decimals : ""}`;
}
/** dd.mm in Polish, the locale's short numeric day and month otherwise. */
export function shortDate(iso: string | null | undefined): string {
  const date = new Date(iso ?? "");
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(getLocale(), { day: "2-digit", month: "2-digit" }).format(date);
}
/** Dollars without cents from $100 up: "$3 210", "$238", "$7,92". */
export function roundUsd(value: number): string {
  return Math.abs(value) >= 100 ? `$${amount(Math.round(value), 0)}` : usd(value);
}
const resetsWord = (n: number) => translate(n === 1 ? "reset" : "resets", polishPlural(n, "reset", "resety", "resetów"));
const freeResets = (n: number) => `${n} ${translate(n === 1 ? "free reset" : "free resets", polishPlural(n, "darmowy reset", "darmowe resety", "darmowych resetów"))}`;
/** "1,6 okna", "2 okna", "5 okien", "1 okno": a fraction takes the genitive singular in Polish. */
export function windowsText(value: number): string {
  const shown = Math.round(value * 10) / 10;
  const text = amount(shown, 1);
  return `${text} ${translate(shown === 1 ? "window" : "windows",
    Number.isInteger(shown) ? polishPlural(shown, "okno", "okna", "okien") : "okna")}`;
}
/** "+4,5k kr.": the credits a window spent past its limit, compact. */
export function compactCredits(value: number): string {
  const abs = Math.abs(value);
  const text = abs >= 1e6 ? `${amount(value / 1e6, 1)}M` : abs >= 1e3 ? `${amount(value / 1e3, abs >= 1e5 ? 0 : 1)}k` : amount(Math.round(value), 0);
  return `${text} ${translate("cr", "kr.")}`;
}

/* ------------------------------------------------------------------------------------------ */
/* Subscription card                                                                            */
/* ------------------------------------------------------------------------------------------ */

export interface CreditCardView {
  pools: PoolView[];
  resets: { dots: number; left: string; right: string | null } | null;
  title: string;
}
/** How many windows fill the card's balance bar. */
export const BAR_WINDOWS = 2;

/**
 * The card's credit block. `current` is the card's window: its percent, its credit-funded calls and pool movement;
 * paying from credits is a window at the limit whose calls went to credits (the ledger) or whose balance fell.
 */
export function creditCardView(range: CreditPoolsOfRange | null | undefined, basis: CreditWindowBasis | null | undefined,
  current: { usedPercent: number | null; creditFunded?: CreditFundedSums | null } = { usedPercent: null }): CreditCardView | null {
  const account = accountCredits(range, basis, codexPoolEvidence(current.creditFunded));
  if (!account) return null;
  const resets = account.resets ? {
    dots: account.resets.count,
    left: freeResets(account.resets.count),
    right: account.resets.nextExpiry ? translate("next until {0}", `najbliższy do ${shortDate(account.resets.nextExpiry)}`, [shortDate(account.resets.nextExpiry)]) : null,
  } : null;
  return { pools: poolViews(account), resets, title: creditsTitle(account) };
}

/** The tooltip: reading time, exact balance and the conversion's basis. */
export function creditsTitle(account: AccountCredits): string {
  return [
    translate("Credits at the account's newest reading ({0}).", `Kredyty z najnowszego odczytu konta (${dayTime(account.readAt)}).`, [dayTime(account.readAt)]),
    account.exact ? translate("Exact balance: {0}.", `Dokładne saldo: ${exactDecimal(account.exact)}.`, [exactDecimal(account.exact)]) : null,
    poolFundingTitle(),
    account.basis?.contextUnavailable ? translate("Context preview unavailable for this sample; showing stored prices.",
      "Podgląd kontekstu niedostępny dla tego pomiaru; pokazano zapisane ceny.") : null,
    account.basis?.sample ? translate(
      "Current sample {0}–{1} ({2} pp): 1 window ≈ {3} credits. The point rate uses the same sample and context preview.",
      `Aktualny pomiar ${dayTime(account.basis.sample.start)}–${dayTime(account.basis.sample.end)} (${account.basis.sample.percent} pp): 1 okno ≈ ${creditsAmount(account.basis.credits)} kr. Kurs punktu korzysta z tego samego pomiaru i podglądu kontekstu.`,
      [dayTime(account.basis.sample.start), dayTime(account.basis.sample.end), account.basis.sample.percent, creditsAmount(account.basis.credits)]) : account.basis ? translate(
      "1 window ≈ {0} credits: the newest window that reached the limit ({1}–{2}), at its model mix.",
      `1 okno ≈ ${creditsAmount(account.basis.credits)} kr.: ostatnie okno, które doszło do limitu (${shortDate(account.basis.start)}–${shortDate(account.basis.end)}), przy jego miksie modeli.`, [creditsAmount(account.basis.credits), shortDate(account.basis.start), shortDate(account.basis.end)])
      : account.kind === "credits" ? translate("No comparable prepared meter sample yet.", "Brak przygotowanego porównywalnego pomiaru licznika.") : null,
    account.basis?.partial ? translate("Incomplete pricing: window capacity is a lower bound, so the window count is an upper estimate. Dollar equivalents use the priced mix only.",
      "Niepełna wycena: pojemność okna jest dolną granicą, więc liczba okien jest górnym oszacowaniem. Ekwiwalent dolarowy dotyczy tylko wycenionego miksu.") : null,
  ].filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------------------------------ */
/* Overview strip, window section, window rail                                                  */
/* ------------------------------------------------------------------------------------------ */

export interface CreditStripView {
  pools: PoolView[];
  /** "3 darmowe resety, najbliższy wygasa 22.10" / "wygasa 05.11". */
  resets: string | null;
  /** The reading time lives here, not on the strip (no provenance on screen). */
  title: string;
}
/** The account-level strip under the window's chips; `basisNumber` is the number of the conversion window. */
export function creditStripView(account: AccountCredits | null): CreditStripView | null {
  if (!account) return null;
  const resets = account.resets ? `${freeResets(account.resets.count)}${account.resets.nextExpiry
    ? translate(", next expires {0}", `, najbliższy wygasa ${shortDate(account.resets.nextExpiry)}`, [shortDate(account.resets.nextExpiry)]) : ""}` : null;
  return { pools: poolViews(account), resets, title: creditsTitle(account) };
}

export interface WindowCreditRow { label: string; value: string; detail: string | null; title?: string }
/**
 * The credit rows under "To okno": calls paid from credits, observed account-dollar movements, used resets.
 * What the credit strip already shows (credits over the limit, available resets) is not repeated (user, 2026-10-15).
 * Rows only where data exists; null without any.
 */
export function windowCreditRows(input: { funded: CreditFundedSums | null | undefined; windowTokens: number | null;
  pools: CreditPoolsOfRange | null | undefined; account: AccountCredits | null }): WindowCreditRow[] | null {
  const rows: WindowCreditRow[] = [];
  const { funded, account } = input;
  const usage = poolUsage(input.pools, codexPoolEvidence(input.funded));
  const resetsUsed = (input.pools?.flows ?? []).filter(flow => flow.unit === "resets").reduce((sum, flow) => sum + flow.spent, 0);
  if (funded && funded.calls > 0) {
    const share = input.windowTokens && input.windowTokens > 0 ? funded.tokens / input.windowTokens * 100 : null;
    const days = shortDate(funded.first) === shortDate(funded.last) ? shortDate(funded.first)
      : `${shortDate(funded.first).replace(/\.\d{2}$/, "")}–${shortDate(funded.last)}`;
    // Without an account balance there is no strip, so the credits over the limit stay here.
    const stripShowsCredits = account != null && account.kind !== "usd" && funded.credits > 0;
    const detail = [translate(funded.calls === 1 ? "call" : "calls", polishPlural(funded.calls, "wywołanie", "wywołania", "wywołań")),
      days, `${compactTokens(funded.tokens)} ${translate("tokens", "tokenów")}`,
      stripShowsCredits ? null : `${funded.credits_unpriced ? "≥" : "≈"} ${creditsAmount(funded.credits)} ${translate("cr", "kr.")}`,
      funded.api_standard > 0 ? `≈ ${roundUsd(funded.api_standard)}` : null,
      share != null ? `+${amount(share, share < 10 ? 1 : 0)}% ${translate("of the window", "okna")}` : null].filter(Boolean).join(" · ");
    rows.push({ label: translate("from credits", "z kredytów"), value: amount(funded.calls, 0), detail });
  }
  for (const pool of usage) {
    if (pool.observedSpend == null) continue;
    const since = input.pools?.flows.find(flow => flow.key === pool.key)?.since ?? input.pools!.read_at;
    rows.push({ label: `${poolLabel(pool)} · ${translate("this window", "to okno")}`,
      value: poolAmount(pool.observedSpend, pool.unit), detail: null,
      title: [translate("Observed increase in account usage, measured from {0}. Changes belong to the later reading's window, even when the earlier reading precedes it.",
        `Zaobserwowany przyrost zużycia konta od ${since}. Zmiany należą do okna późniejszego odczytu, także gdy poprzedni odczyt jest sprzed jego początku.`, [since]),
      poolFundingTitle()].join(" ") });
  }
  if (resetsUsed > 0) {
    const available = account?.resets?.count ?? 0;
    rows.push({ label: translate("resets", "resety"), value: translate("{0} used", `${resetsUsed} ${polishPlural(resetsUsed, "użyty", "użyte", "użytych")}`, [resetsUsed]),
      detail: `${available} ${translate("available", polishPlural(available, "dostępny", "dostępne", "dostępnych"))}${account?.resets?.nextExpiry
        ? translate(" · until {0}", ` · do ${shortDate(account.resets.nextExpiry)}`, [shortDate(account.resets.nextExpiry)]) : ""}` });
  }
  return rows.length ? rows : null;
}
function compactTokens(value: number): string {
  const abs = Math.abs(value);
  return abs >= 1e9 ? `${amount(value / 1e9, 2)}B` : abs >= 1e6 ? `${amount(value / 1e6, 0)}M` : abs >= 1e3 ? `${amount(value / 1e3, 0)}k` : amount(value, 0);
}

/** The rail's tag beside a window's percent: credits spent past its limit. */
export function creditTag(funded: CreditFundedSums | null | undefined): { text: string; title: string } | null {
  if (!funded || funded.calls <= 0 || !(funded.credits > 0)) return null;
  return { text: `+${compactCredits(funded.credits)}`, title: translate(
    "Paid from credits after the limit: {0} calls, {1} tokens, ≈ {2} credits ({3} → {4}).",
    `Opłacone kredytami po limicie: ${amount(funded.calls, 0)} wywołań, ${compactTokens(funded.tokens)} tokenów, ≈ ${creditsAmount(funded.credits)} kr. (${dayTime(funded.first)} → ${dayTime(funded.last)}).`, [amount(funded.calls, 0), compactTokens(funded.tokens), creditsAmount(funded.credits), dayTime(funded.first), dayTime(funded.last)]) };
}

export interface RailCreditsView { balance: string; used: string | null; resets: string | null; resetsRight: string | null; title: string }
/** The block at the bottom of the window rail: the balance, credits used in the visible windows, resets. */
export function railCreditsView(account: AccountCredits | null, visible: ReadonlyArray<CreditFundedSums | null | undefined>): RailCreditsView | null {
  if (!account || account.kind !== "credits") return null;
  const used = visible.reduce((total, funded) => total + (funded?.credits ?? 0), 0);
  return {
    balance: account.unlimited ? translate("unlimited", "bez limitu") : account.remaining == null ? "—" : creditsAmount(account.remaining),
    used: used > 0 ? creditsAmount(used) : null,
    resets: account.resets ? `${account.resets.count} ${resetsWord(account.resets.count)}` : null,
    resetsRight: account.resets?.nextExpiry ? translate("until {0}", `do ${shortDate(account.resets.nextExpiry)}`, [shortDate(account.resets.nextExpiry)]) : null,
    title: creditsTitle(account),
  };
}

/**
 * An account's credits from its Codex cycles (/api/usage-series): the pools of the newest pool reading and the
 * current conversion sample, with its window number on the rail. Null when no cycle carries pools.
 */
export function accountCreditsOfCycles(cycles: ReadonlyArray<{ number: number; raw: ApiCycle }>, current?: CurrentPointBasis | null,
  currentPools?: CreditPoolsOfRange | null):
  { account: AccountCredits | null; basisNumber: number | null } | null {
  let newest: CreditPoolsOfRange | null = null;
  for (const cycle of cycles) {
    const pools = cycle.raw.credit_pools;
    if (pools && (!newest || Date.parse(pools.read_at) > Date.parse(newest.read_at))) newest = pools;
  }
  if (currentPools !== undefined) newest = currentPools;
  if (!newest) return null;
  const basis = creditBasisOf(current === undefined ? currentPointBasis(cycles.map(cycle => cycle.raw)) : current);
  const number = basis ? cycles.find(cycle => (cycle.raw.window_start_iso ?? cycle.raw.work_from_ts) === basis.start)?.number ?? null : null;
  return { account: accountCredits(newest, basis), basisNumber: number };
}
