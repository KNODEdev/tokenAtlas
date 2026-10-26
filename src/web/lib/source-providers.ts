import type { VendorId } from "../../sync/contracts";
import type { SourceHealthRow } from "../../shared/source-health";
import type { ApiAccount, IdentityWarning, RosterProbe, SyncStatus } from "./api";
import { translate } from "./i18n";
import { polishPlural } from "./mixFormat";
import { probeMachineRows } from "./probe";
import { compact } from "./format";

/** Every provider the app reads, plus the shared journal of limit readings (sync scope `gauges`). */
export type SourceProviderId = Exclude<VendorId, "gauges"> | "glm" | "gauges";
export interface SourceProviderRow {
  id: SourceProviderId;
  /** The sync scope that refreshes the row; GLM has no event source, its readings arrive with the limit readings. */
  sync: VendorId | null;
  /** Newest data: a session for providers with events, a limit reading for GLM and the readings journal. */
  latest: string | null;
  /** Recorded events; null where the provider records none or the count is not reported. */
  events: number | null;
}

const ORDER: SourceProviderId[] = ["codex", "claude", "opencode", "grok", "gemini", "glm", "gauges"];
/** Catalog and account files name some providers by company. */
const ALIASES: Record<string, SourceProviderId> = { openai: "codex", anthropic: "claude", google: "gemini", xai: "grok", zai: "glm" };
export const providerOf = (vendor: string | null | undefined): string => {
  const key = (vendor ?? "").toLowerCase();
  return ALIASES[key] ?? key;
};

const newest = (values: (string | null | undefined)[]): string | null =>
  values.reduce<string | null>((latest, value) => value && Number.isFinite(Date.parse(value)) && (!latest || Date.parse(value) > Date.parse(latest)) ? value : latest, null);

/** Account rows repeat an account once per profile; each account's events count once. */
function eventsByProvider(accounts: ApiAccount[]): Map<string, number> {
  const perAccount = new Map<string, { provider: string; events: number }>();
  for (const account of accounts) {
    const provider = providerOf(account.vendor);
    const key = `${provider}\u0000${account.id}`;
    perAccount.set(key, { provider, events: Math.max(perAccount.get(key)?.events ?? 0, account.event_rows) });
  }
  const totals = new Map<string, number>();
  for (const { provider, events } of perAccount.values()) totals.set(provider, (totals.get(provider) ?? 0) + events);
  return totals;
}

export function sourceProviderRows({ sources, probes, accounts, tables }: {
  sources: SourceHealthRow[];
  probes: RosterProbe[];
  accounts: ApiAccount[];
  /** Exact event table sizes from /api/health, when reported. */
  tables?: { events?: number; claude_events?: number };
}): SourceProviderRow[] {
  const events = eventsByProvider(accounts);
  const readings = (provider?: string) => newest([
    ...probes.filter((probe) => !provider || providerOf(probe.provider) === provider).map((probe) => probe.reading?.ts),
    ...sources.filter((row) => !provider || providerOf(row.vendor) === provider).map((row) => row.last_meter),
  ]);
  return ORDER.map((id) => {
    if (id === "gauges") return { id, sync: "gauges", latest: readings(), events: null };
    if (id === "glm") return { id, sync: null, latest: readings("glm"), events: null };
    const exact = id === "codex" ? tables?.events : id === "claude" ? tables?.claude_events : undefined;
    const counted = exact ?? events.get(id) ?? 0;
    return {
      id, sync: id,
      latest: newest([
        ...sources.filter((row) => providerOf(row.vendor) === id).map((row) => row.last_session),
        ...accounts.filter((account) => providerOf(account.vendor) === id).map((account) => account.last_event_ts),
      ]),
      events: counted > 0 ? counted : null,
    };
  });
}

/** Age within the report's freshness threshold reads as current; older data is flagged; missing data has no tone. */
export function ageTone(value: string | null, olderAfterHours: number, now = Date.now()): "ok" | "warn" | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return now - ms <= olderAfterHours * 3_600_000 ? "ok" : "warn";
}

const SCALE_HOURS = 30 * 24;
/** Position on the data-age scale (0 = now, 1 = 30 days or more); logarithmic so minutes and weeks both read. */
export function agePosition(value: string, now = Date.now()): number {
  const hours = Math.max(0, (now - Date.parse(value)) / 3_600_000);
  return Math.min(1, Math.log10(1 + hours) / Math.log10(1 + SCALE_HOURS));
}

export type SourceCheckLink = "profiles" | "periods" | "rates";
export interface SourceCheck {
  key: string;
  tone: "warn" | "info" | "ok";
  title: string;
  /** One short line; anything that grows with the data (paths, account ids) goes to `items`, shown folded. */
  detail: string;
  items?: string[];
  link?: SourceCheckLink;
}

const plural = (n: number, en: [string, string], pl: [string, string, string]) =>
  `${n} ${translate(n === 1 ? en[0] : en[1], polishPlural(n, ...pl))}`;

/**
 * One line per data-quality check (UI audit finding 7), each pointing to the one place that fixes it.
 * Per-account freshness and calibration live on the Overview's status block and "Data and calibration" tab.
 */
export function sourceChecks({ probes, accounts, unpricedTokens, unpricedModels, identity, watch }: {
  probes: RosterProbe[];
  accounts: ApiAccount[];
  unpricedTokens: number;
  unpricedModels: number;
  identity: IdentityWarning[];
  watch: SyncStatus["watch"];
}): SourceCheck[] {
  const checks: SourceCheck[] = [];
  const probeRows = probeMachineRows(probes);
  const failing = probeRows.filter((row) => row.failing);
  for (const row of failing) {
    checks.push({ key: `probe:${row.key}`, tone: "warn", link: "profiles",
      title: `${translate("Limit reading", "Odczyt limitu")} ${row.subject}`,
      detail: [row.machine, row.ok, row.error].filter(Boolean).join(" · ") });
  }
  if (!failing.length) {
    const subjects = new Set(probeRows.map((row) => `${row.provider}/${row.subject}`)).size;
    checks.push(subjects
      ? { key: "probes", tone: "ok", title: translate("Limit readings", "Odczyty limitu"),
        detail: plural(subjects, ["subscription is read without errors", "subscriptions are read without errors"], ["subskrypcja odczytywana bez błędów", "subskrypcje odczytywane bez błędów", "subskrypcji odczytywanych bez błędów"]) }
      : { key: "probes", tone: "info", title: translate("Limit readings", "Odczyty limitu"),
        detail: translate("no computer has recorded a reading yet", "żaden komputer nie zapisał jeszcze odczytu") });
  }
  const uncounted = [...new Map(accounts.filter((account) => account.has_events && !account.has_gauge)
    .map((account) => [`${providerOf(account.vendor)}\u0000${account.id}`, account.id])).values()];
  checks.push(uncounted.length
    ? { key: "counters", tone: "warn", link: "periods",
      title: plural(uncounted.length, ["subscription without a counter", "subscriptions without a counter"], ["subskrypcja bez licznika", "subskrypcje bez licznika", "subskrypcji bez licznika"]),
      detail: translate("events, but neither rate-limit headers nor an account reading; the percentage is calculated", "zdarzenia, ale ani nagłówków, ani odczytu konta; procent jest wyliczany"),
      items: uncounted }
    : { key: "counters", tone: "ok", title: translate("Counters", "Liczniki"),
      detail: translate("every subscription with events has a counter", "każda subskrypcja ze zdarzeniami ma licznik") });
  checks.push(unpricedTokens > 0
    ? { key: "prices", tone: "info", link: "rates",
      title: plural(unpricedModels, ["model without a price", "models without a price"], ["model bez ceny", "modele bez ceny", "modeli bez ceny"]),
      detail: `${compact(unpricedTokens)} ${translate("tokens without an API price", "tokenów bez wyceny API")}` }
    : { key: "prices", tone: "ok", title: translate("Model prices", "Ceny modeli"),
      detail: translate("every used model has a price", "każdy użyty model ma cenę") });
  checks.push(identity.length
    ? { key: "identity", tone: "warn", title: translate("Account identity", "Tożsamość kont"),
      detail: `${plural(identity.length, ["warning", "warnings"], ["ostrzeżenie", "ostrzeżenia", "ostrzeżeń"])} — ${translate("details below", "szczegóły poniżej")}` }
    : { key: "identity", tone: "ok", title: translate("Account identity", "Tożsamość kont"), detail: translate("no warnings", "brak ostrzeżeń") });
  if (watch) {
    const problems = [...watch.missingRoots, ...watch.errors];
    checks.push(problems.length
      ? { key: "watch", tone: "warn", title: translate("Watched source folders", "Obserwowane foldery źródeł"),
        detail: [
          watch.missingRoots.length ? plural(watch.missingRoots.length, ["folder missing", "folders missing"], ["brakujący folder", "brakujące foldery", "brakujących folderów"]) : null,
          watch.errors.length ? plural(watch.errors.length, ["error", "errors"], ["błąd", "błędy", "błędów"]) : null,
        ].filter(Boolean).join(" · "),
        items: problems }
      : { key: "watch", tone: "ok", title: translate("Watched source folders", "Obserwowane foldery źródeł"),
        detail: plural(watch.watchedRoots.length, ["folder watched", "folders watched"], ["folder obserwowany", "foldery obserwowane", "folderów obserwowanych"]) });
  }
  return checks;
}
