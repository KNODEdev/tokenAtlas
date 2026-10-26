import fs from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { ARCHIVE_LOGICAL_ROOT, CONFIG_ROOT, configFile, expandPath } from "../config/paths";
import { atomicArchiveWrite } from "../sync/archive-publication";
import { normEraKey, normEraVendor } from "./eras";
import { periodInstant, periodSubjectKey, type DatedPeriod } from "./account-periods";
import { archiveFolderOf, type ArchiveFolder } from "./event-source";
import { readLedgerSums, sumVendors, type LedgerSum } from "./ledger-sums";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { CodexLedgerNotReady } from "../db/codex-price-ledger";
import { ACCOUNT_PERIODS, PLAN_PERIODS, loadPeriodRows, type IdentifiedPeriod, type PeriodTable } from "../db/period-store";
import {
  PERIOD_DECLARATIONS_FILE, applyPeriodDeclarations, parsePeriodDeclarations,
  type AccountDeclaration, type PeriodDeclarations, type PeriodDeclarationsFile, type PlanDeclaration,
} from "./period-declarations";
import { rememberedVendorAccounts, type VendorAccount } from "./vendor-discovery";
import { codexIdentityAliases, rememberedCodexAccounts, type DiscoveredCodexAccount } from "./codex-discovery";
import { readAccountsV2 } from "../config/accounts-document";
import { resolvePlanFacts, type PlansCatalog } from "../shared/plan-catalog";
import { NO_PLAN, canonicalPeriodPlan, looksLikeNoPlan } from "../shared/period-end";
import type { SubscriptionV2, SourceV2 } from "../config/accounts-v2";
import type {
  AccountDeclarationInput, AccountPeriodRow, AccountPeriodsView, PeriodAccount, PeriodEdit,
  PeriodEditPreview, PeriodEditResult, PeriodSource, PlanDeclarationInput, PlanPeriodRow,
} from "../shared/account-periods";

/**
 * The Settings card "Okresy kont" (docs/account-periods-model-2026-09-21.md §5): it shows the rows of
 * both period tables next to what they rest on — the archive folder they speak about, the events
 * recorded there, the accounts known to this machine — and edits the owner's declarations file.
 *
 * Only declared rows are editable, and only through `config/account-periods.json`: the file is the
 * source of those rows (`golden-rules.md` §2), the tables follow it. Observed rows come from probe
 * readings and stay as evidence under a declaration that disagrees with them.
 */
export interface AccountPeriodsContext {
  sqlite: Database;
  /** Archive paths; explicit so tests can work on a temporary copy. */
  accountsFile?: string;
  archiveRoot?: string;
  declarationsFile?: string;
  discovered?: VendorAccount[];
  codexDiscovered?: DiscoveredCodexAccount[];
  /** Names each plan row and gives its multiplier; without it rows carry no tier. */
  plansCatalog?: PlansCatalog;
}

/**
 * The catalog plan behind a period row, as capacity reads it (`credits_multiplier`). Claude's
 * multipliers are relative to Pro, so Pro itself is ×1 although the catalog leaves it unset.
 */
export function planTier(catalog: PlansCatalog | undefined, provider: string, plan: string, from: string):
  { label: string; multiplier: number | null } | null {
  if (!catalog) return null;
  const facts = resolvePlanFacts(catalog, provider, plan, from);
  return facts.plan_id === null || facts.plan_id === NO_PLAN ? null : { label: facts.label, multiplier: facts.multiplier };
}

/** `revision` of a view built without a declarations file; the first edit creates it. */
export const PERIOD_DECLARATIONS_ABSENT = "absent";
export const PERIOD_REVISION_MISMATCH = "Deklaracje zmieniły się od ostatniego odczytu. Odśwież dane przed zapisem.";

const declarationsFileOf = (ctx: AccountPeriodsContext) => ctx.declarationsFile ?? path.join(CONFIG_ROOT, PERIOD_DECLARATIONS_FILE);
const archiveRootOf = (ctx: AccountPeriodsContext) => ctx.archiveRoot ?? ARCHIVE_LOGICAL_ROOT;

const trimmed = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const instantOrNull = (value: string): number | null => {
  try { return periodInstant(value, "from"); } catch { return null; }
};

// ---------------------------------------------------------------- archive folders

/** One archive folder, the subject of an account period: the shared rule of `event-source.ts`. */
const archiveFolder = archiveFolderOf;

const basename = (file: string | null | undefined): string | null => {
  const parts = String(file ?? "").replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts.length > 1 ? parts.at(-1) || null : null;
};

/** The part of an `accounts.json` entry this view reads: which local profile is kept in which archive folder. */
interface AccountsDeclaration {
  vendor: string; machine?: string; home: string; source_home?: string;
}

/** A missing or broken `accounts.json` costs the view its folder names, not the whole card. */
function accountsDeclarations(file: string, root: string): { sources: AccountsDeclaration[]; subscriptions: SubscriptionV2[] } {
  const document = readAccountsV2(file);
  return { subscriptions: document.subscriptions, sources: document.sources.map(d => ({ ...d,
    home: expandPath(d.home, { archive: root }),
    ...(d.source_home ? { source_home: expandPath(d.source_home, { archive: root }) } : {}),
  })) };
}

/**
 * Computer and local profile directory of an archive folder. A declaration names both; without one
 * the conventional folder name does, by the rule `archiveSourceOf` applies in the other direction:
 * Claude's folder carries no login (`claude/EXAMPLE-MAIN`), every other vendor's ends in `-<login>`.
 */
function locateSource(folder: ArchiveFolder, declarations: readonly AccountsDeclaration[], root: string): Pick<PeriodSource, "machine" | "profile"> {
  // Several declarations name one folder after a profile moved; the open, latest one describes it today.
  const naming = declarations.filter(d => archiveFolder(d.home, root)?.key === folder.key);
  const declared = naming[0];
  if (declared) return { machine: trimmed(declared.machine) || null, profile: basename(declared.source_home) };
  const name = folder.name ?? folder.key.split("/")[1] ?? null;
  if (!name) return { machine: null, profile: null };
  if (folder.provider === "claude") {
    // The desktop application writes its own folder; it is not a profile directory.
    const desktop = /-desktop$/i.test(name);
    return desktop ? { machine: name.slice(0, -"-desktop".length), profile: null } : { machine: name, profile: ".claude" };
  }
  const cut = name.lastIndexOf("-");
  return cut > 0 ? { machine: name.slice(0, cut), profile: `.${folder.provider}` } : { machine: null, profile: null };
}

/**
 * The computer of a ledger source key (`codex/example-laptop-a-sample_a`), by the same rule as the Settings card: a declaration
 * in `accounts.json` names it, the conventional folder name otherwise. One spelling per computer (the first declared one).
 */
export function sourceMachineResolver(accountsFile = configFile("accounts.json"), root = ARCHIVE_LOGICAL_ROOT): (source: string | null) => string | null {
  let declarations: AccountsDeclaration[] = [];
  try { declarations = accountsDeclarations(accountsFile, root).sources; } catch { /* folder names only */ }
  const spelling = new Map<string, string>();
  for (const d of declarations) if (trimmed(d.machine)) spelling.set(normEraKey(trimmed(d.machine)), spelling.get(normEraKey(trimmed(d.machine))) ?? trimmed(d.machine));
  const cache = new Map<string, string | null>();
  return (source) => {
    if (!source) return null;
    const key = normEraKey(source);
    if (cache.has(key)) return cache.get(key)!;
    const [provider, name] = key.split("/");
    const machine = provider && name
      ? locateSource({ key: `${provider}/${name}`, provider: normEraVendor(provider), name }, declarations, root).machine : null;
    const shown = machine ? spelling.get(normEraKey(machine)) ?? machine : null;
    cache.set(key, shown);
    return shown;
  };
}

// ---------------------------------------------------------------- recorded events

interface FolderDay { folder: ArchiveFolder; day: string; calls: number; first_ts: string; last_ts: string }
/**
 * What was recorded in each archive folder, per day, from the ledgers' sums by the place of a call.
 * Claude's source is its conversation folder (`source`); every other provider's is its store root
 * (`home`). A ledger still preparing has no answer yet: null, never a partial count.
 */
function folderDays(sqlite: Database, root: string, range: { since?: string; until?: string } = {}): FolderDay[] | null {
  let rows: LedgerSum[];
  try { rows = readLedgerSums(sqlite, { vendors: sumVendors(), grain: "day", ...range }); }
  catch (error) { if (error instanceof SubscriptionFactsPending || error instanceof CodexLedgerNotReady) return null; throw error; }
  const claudeNames = claudeFolderNames(sqlite, root);
  return rows.flatMap(row => {
    const folder = row.vendor === "claude"
      ? row.source && { key: row.source, provider: "claude", name: claudeNames.get(row.source) ?? null }
      : archiveFolder(row.home, root);
    return folder ? [{ folder, day: row.day, calls: row.calls, first_ts: row.first_ts, last_ts: row.last_ts }] : [];
  });
}
/** Claude folder keys are lower-case; their names keep the case the archive gives them, as the file registry records it. */
function claudeFolderNames(sqlite: Database, root: string): Map<string, string> {
  const names = new Map<string, string>();
  if (!sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='claude_files'").get()) return names;
  for (const { path: file } of sqlite.query("SELECT path FROM claude_files").all() as Array<{ path: string }>) {
    const folder = archiveFolder(file, root);
    if (folder?.name && !names.has(folder.key)) names.set(folder.key, folder.name);
  }
  return names;
}

/**
 * What was recorded for one source inside a period, at day precision. `until` is exclusive,
 * so the last covered day is the day of the instant just before it: a midnight `until` stops the day
 * before, an `until` with a time of day still counts its own day.
 */
function eventsInRange(sqlite: Database, root: string, source: string, from: string, until: string | null): PeriodEditPreview["events"] {
  const firstDay = new Date(periodInstant(from, "from")).toISOString().slice(0, 10);
  const lastDay = until === null ? null : new Date(periodInstant(until, "until") - 1).toISOString().slice(0, 10);
  const rows = folderDays(sqlite, root, { since: firstDay, ...(lastDay === null ? {} : { until: lastDay }) });
  if (!rows) return null;
  const key = normEraKey(source), days = new Set<string>();
  const events: NonNullable<PeriodEditPreview["events"]> = { calls: 0, days: 0, first: null, last: null };
  for (const row of rows) {
    if (row.folder.key !== key) continue;
    days.add(row.day);
    events.calls += row.calls;
    if (events.first === null || row.first_ts < events.first) events.first = row.first_ts;
    if (events.last === null || row.last_ts > events.last) events.last = row.last_ts;
  }
  events.days = days.size;
  return events;
}

// ---------------------------------------------------------------- the view

function buildSources(sqlite: Database, root: string, declarations: readonly AccountsDeclaration[], rows: readonly IdentifiedPeriod[]): PeriodSource[] {
  interface Draft { provider: string; key: string; name: string | null; events: PeriodSource["events"] }
  const drafts = new Map<string, Draft>();
  const draft = (folder: ArchiveFolder): Draft => {
    const found = drafts.get(folder.key);
    if (!found) {
      const fresh: Draft = { provider: folder.provider, key: folder.key, name: folder.name, events: null };
      drafts.set(folder.key, fresh);
      return fresh;
    }
    found.name = found.name ?? folder.name;
    return found;
  };
  for (const row of declarations) {
    const folder = archiveFolder(row.home, root);
    if (folder) draft(folder);
  }
  for (const row of folderDays(sqlite, root) ?? []) {
    const folder = row.folder;
    const found = draft(folder), events = found.events ?? { first: row.first_ts, last: row.last_ts, calls: 0 };
    if (row.first_ts < events.first) events.first = row.first_ts;
    if (row.last_ts > events.last) events.last = row.last_ts;
    events.calls += row.calls;
    found.events = events;
  }
  for (const row of rows) {
    const key = normEraKey(row.subject), parts = key.split("/");
    if (!parts[0] || !parts[1]) continue;
    draft({ key: `${parts[0]}/${parts[1]}`, provider: normEraVendor(row.provider), name: null });
  }
  return [...drafts.values()]
    .map((d) => ({ provider: d.provider, key: d.key, ...locateSource(d, declarations, root), events: d.events }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.key.localeCompare(b.key));
}

function buildAccounts(
  ctx: AccountPeriodsContext, declarations: readonly SubscriptionV2[],
  accountPeriods: readonly AccountPeriodRow[], planPeriods: readonly PlanPeriodRow[],
): PeriodAccount[] {
  const found = new Map<string, PeriodAccount>();
  const add = (vendor: string, id: string, label: string | null, current: boolean): void => {
    const provider = normEraVendor(vendor), key = `${provider}|${id}`, prior = found.get(key);
    if (!prior) { found.set(key, { provider, id, label: trimmed(label) || id, current }); return; }
    if (prior.label === prior.id && trimmed(label)) prior.label = trimmed(label);
    prior.current ||= current;
  };
  for (const account of [...rememberedVendorAccounts(ctx.sqlite, declarations), ...(ctx.discovered ?? [])]) add(account.vendor, account.id, account.email, account.current);
  const remembered = rememberedCodexAccounts(ctx.sqlite), aliases = codexIdentityAliases(remembered, declarations);
  // A minted id of a declared login is that login, not an account of its own.
  for (const evidence of remembered) if (!aliases.has(evidence.subscription.toLowerCase())) add("codex", evidence.subscription, evidence.email, false);
  for (const account of ctx.codexDiscovered ?? []) add("codex", account.id, account.email, account.current);
  // `accounts.json` is the only place that still names historical accounts; `id::variant` is a
  // billing mode of one account (§4), not an account of its own.
  for (const row of declarations) if (trimmed(row.id) && !row.id.includes("::")) add(row.vendor, row.id, row.account ?? null, false);
  for (const row of accountPeriods) add(row.provider, row.account, null, false);
  for (const row of planPeriods) add(row.provider, row.account, null, false);
  return [...found.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

interface LoadedDeclarations {
  present: boolean;
  revision: string;
  errors: string[];
  document: PeriodDeclarationsFile;
  /** False when the file exists but is not a `version: 1` document, so an edit must not rewrite it. */
  editable: boolean;
  /** The file's rows as the tables would hold them; null for a rejected file, whose previous rows stay in force. */
  parsed: PeriodDeclarations | null;
}

function loadDeclarations(file: string): LoadedDeclarations {
  const empty: PeriodDeclarationsFile = { version: 1, accounts: [], plans: [] };
  if (!fs.existsSync(file)) return { present: false, revision: PERIOD_DECLARATIONS_ABSENT, errors: [], document: empty, editable: true,
    parsed: { accounts: [], plans: [], errors: [], digest: PERIOD_DECLARATIONS_ABSENT } };
  const source = fs.readFileSync(file, "utf8"), parsed: PeriodDeclarations = parsePeriodDeclarations(source);
  let document: PeriodDeclarationsFile | null = null;
  try {
    const value = JSON.parse(source) as PeriodDeclarationsFile;
    if (value && typeof value === "object" && value.version === 1) document = value;
  } catch { /* reported through `parsed.errors`; the rows of the last good version stay in the tables. */ }
  return { present: true, revision: parsed.digest, errors: parsed.errors, document: document ?? empty, editable: document !== null,
    parsed: parsed.errors.length ? null : parsed };
}

/** The owner's note lives in the file, not in the tables; it is matched back onto its declared row. */
function noteIndex(rows: readonly unknown[], subject: (row: Record<string, unknown>) => unknown): Map<string, string> {
  const notes = new Map<string, string>();
  for (const value of rows) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>, at = instantOrNull(trimmed(row.from)), note = trimmed(row.note);
    if (at === null || !note) continue;
    notes.set(`${periodSubjectKey(trimmed(row.provider), trimmed(subject(row)))}|${at}`, note);
  }
  return notes;
}
const noteKey = (provider: string, subject: string, from: string): string | null => {
  const at = instantOrNull(from);
  return at === null ? null : `${periodSubjectKey(provider, subject)}|${at}`;
};

/**
 * Declared rows as the file holds them. After a save the tables can lag behind the file (a busy
 * writer leaves them to the 60 s feed), and an edit that quoted the file's revision must name rows
 * that are in that file. A table row that already matches keeps its id; a pending one gets a
 * negative id. Without a valid file the tables' declared rows stay, as they are what is in force.
 */
function withFileDeclarations(rows: IdentifiedPeriod[], declared: readonly DatedPeriod[] | null): IdentifiedPeriod[] {
  if (!declared) return rows;
  const stored = rows.filter((row) => row.origin === "declared");
  const same = (a: DatedPeriod, b: DatedPeriod) => a.provider === b.provider && normEraKey(a.subject) === normEraKey(b.subject)
    && instantOrNull(a.from) === instantOrNull(b.from) && a.value === b.value
    && (a.until === null ? null : instantOrNull(a.until)) === (b.until === null ? null : instantOrNull(b.until));
  // The tables' order: provider, subject, start, compared as SQLite compares text (binary).
  const at = (row: DatedPeriod) => instantOrNull(row.from) ?? 0;
  const binary = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return [...rows.filter((row) => row.origin !== "declared"),
    ...declared.map((row, index) => ({ ...row, id: stored.find((candidate) => same(candidate, row))?.id ?? -(index + 1) }))]
    .sort((a, b) => binary(a.provider, b.provider) || binary(a.subject, b.subject) || at(a) - at(b));
}

export function buildAccountPeriodsView(ctx: AccountPeriodsContext): AccountPeriodsView {
  const root = archiveRootOf(ctx), file = declarationsFileOf(ctx), loaded = loadDeclarations(file);
  const declarations = accountsDeclarations(ctx.accountsFile ?? configFile("accounts.json"), root);
  const accountRows = withFileDeclarations(loadPeriodRows(ctx.sqlite, ACCOUNT_PERIODS), loaded.parsed?.accounts ?? null);
  const planRows = withFileDeclarations(loadPeriodRows(ctx.sqlite, PLAN_PERIODS), loaded.parsed?.plans ?? null);
  const accountNotes = noteIndex(loaded.document.accounts ?? [], (row) => row.source);
  const planNotes = noteIndex(loaded.document.plans ?? [], (row) => row.account);
  const note = (notes: Map<string, string>, row: IdentifiedPeriod): string | null => {
    if (row.origin !== "declared") return null;
    const key = noteKey(row.provider, row.subject, row.from);
    return (key && notes.get(key)) ?? null;
  };
  const base = (row: IdentifiedPeriod, notes: Map<string, string>) => ({
    id: row.id, provider: row.provider, from: row.from, until: row.until, origin: row.origin,
    firstSeen: row.firstSeen, lastSeen: row.lastSeen, readings: row.readings, evidence: row.evidence, note: note(notes, row),
  });
  // Declarations keep the folder as typed (`claude/EXAMPLE-MAIN`); the view names it by the source key.
  const accountPeriods: AccountPeriodRow[] = accountRows.map((row) => ({ ...base(row, accountNotes), source: normEraKey(row.subject), account: row.value }));
  const planPeriods: PlanPeriodRow[] = planRows.map((row) => ({
    ...base(row, planNotes), account: row.subject, plan: row.value,
    amountMinor: row.amountMinor ?? null, currency: row.currency ?? null,
    tier: planTier(ctx.plansCatalog, row.provider, row.value, row.from),
    anchor: row.anchor ?? null, cycleMonths: row.cycleMonths ?? null,
  }));
  return {
    revision: loaded.revision,
    sources: buildSources(ctx.sqlite, root, declarations.sources, accountRows),
    accounts: buildAccounts(ctx, declarations.subscriptions, accountPeriods, planPeriods),
    accountPeriods,
    planPeriods,
    declarations: { file, present: loaded.present, errors: loaded.errors },
  };
}

// ---------------------------------------------------------------- editing the declarations file

function checkBounds(from: string, until: string | null): void {
  let start: number;
  try { start = periodInstant(from, "from"); } catch { throw new Error(`Nieprawidłowa data początku: '${from}'.`); }
  if (until === null) return;
  let end: number;
  try { end = periodInstant(until, "until"); } catch { throw new Error(`Nieprawidłowa data końca: '${until}'.`); }
  if (end <= start) throw new Error("Koniec okresu musi być późniejszy niż początek.");
}

function requireFields(fields: Record<string, string>): void {
  const missing = Object.entries(fields).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`Uzupełnij pola: ${missing.join(", ")}.`);
}

function accountRow(input: AccountDeclarationInput): AccountDeclaration {
  const provider = trimmed(input.provider), source = trimmed(input.source), account = trimmed(input.account);
  const from = trimmed(input.from), evidence = trimmed(input.evidence), until = trimmed(input.until) || null, note = trimmed(input.note);
  requireFields({ provider, source, account, from, evidence });
  checkBounds(from, until);
  return { provider, source, account, from, until, evidence, ...(note ? { note } : {}) };
}

function planRow(input: PlanDeclarationInput): PlanDeclaration {
  const provider = trimmed(input.provider), account = trimmed(input.account);
  // Any spelling of the reserved value is stored as the one the reader accepts.
  const plan = looksLikeNoPlan(input.plan) ? NO_PLAN : trimmed(input.plan);
  const from = trimmed(input.from), evidence = trimmed(input.evidence), until = trimmed(input.until) || null, note = trimmed(input.note);
  requireFields({ provider, account, plan, from, evidence });
  checkBounds(from, until);
  // "No subscription" has no payment; the editor's default currency alone would only be noise there.
  const amount = input.amount_minor ?? null, currency = plan === NO_PLAN && amount === null ? null : trimmed(input.currency) || null;
  if (amount !== null && !Number.isSafeInteger(amount)) throw new Error('Pole "amount_minor" musi być liczbą całkowitą (grosze/centy).');
  // The renewal day only matters when it differs from the start; a monthly cycle is the default and is not written.
  const anchor = trimmed(input.anchor) || null, months = input.cycle_months ?? null;
  if (anchor !== null) {
    try { periodInstant(anchor, "anchor"); } catch { throw new Error(`Nieprawidłowa data odnowienia: '${anchor}'.`); }
  }
  if (months !== null && months !== 1 && months !== 12) throw new Error("Okres rozliczeniowy to 1 (miesięczny) albo 12 (roczny) miesięcy.");
  const ownAnchor = anchor !== null && plan !== NO_PLAN && periodInstant(anchor, "anchor") !== periodInstant(from, "from");
  return { provider, account, plan, from, until, evidence, ...(amount !== null ? { amount_minor: amount } : {}), ...(currency ? { currency } : {}),
    ...(ownAnchor ? { anchor } : {}), ...(months === 12 && plan !== NO_PLAN ? { cycle_months: 12 } : {}), ...(note ? { note } : {}) };
}

/**
 * Where the edited row sits in the file. The key is the subject and the start instant, which is
 * unique per provider; everything else in the file stays exactly where the owner put it.
 */
function locateRow<T extends { provider: string; from: string }>(
  list: readonly T[], subjectOf: (row: T) => string, subject: string, from: string, provider: string | null,
): number {
  const at = instantOrNull(from), wanted = normEraKey(subject);
  const matches = list.flatMap((row, index) => {
    if (normEraKey(subjectOf(row)) !== wanted) return [];
    if (!((at !== null && instantOrNull(row.from) === at) || row.from === from)) return [];
    if (provider && normEraVendor(row.provider) !== normEraVendor(provider)) return [];
    return [index];
  });
  if (!matches.length) throw new Error(`Nie ma zadeklarowanego wiersza dla ${subject} od ${from}.`);
  if (matches.length > 1) throw new Error(`Kilka zadeklarowanych wierszy pasuje do ${subject} od ${from}. Popraw plik deklaracji.`);
  return matches[0]!;
}

function spliceRow<T extends { provider: string; from: string }>(
  list: T[], replace: { subject: string; from: string } | null, row: T | null, subjectOf: (row: T) => string,
): void {
  if (!replace) {
    if (!row) throw new Error("Wskaż wiersz, który ma zostać usunięty.");
    list.push(row);
    return;
  }
  const index = locateRow(list, subjectOf, replace.subject, replace.from, row?.provider ?? null);
  if (row) list[index] = row; else list.splice(index, 1);
}

/** Observed rows of the same subject that the new declared row covers and disagrees with. */
function overridesOf(
  rows: readonly IdentifiedPeriod[], provider: string, subject: string, from: string, until: string | null, value: string,
): PeriodEditPreview["overrides"] {
  const key = periodSubjectKey(provider, subject), start = periodInstant(from, "from");
  const end = until === null ? Infinity : periodInstant(until, "until");
  return rows
    .filter((row) => row.origin === "observed" && periodSubjectKey(row.provider, row.subject) === key && row.value !== value
      && periodInstant(row.from, "from") < end && start < (row.until === null ? Infinity : periodInstant(row.until, "until")))
    .map((row) => ({ id: row.id, from: row.from, until: row.until, value: row.value }));
}

interface PreparedEdit { document: PeriodDeclarationsFile; preview: PeriodEditPreview }

/** Declared rows of the new row's subject that start before it and still run at its start. */
function earlierRunningInto<T extends { provider: string; from: string; until?: string | null }>(
  list: readonly T[], row: T, subjectOf: (row: T) => string,
): T[] {
  const key = periodSubjectKey(row.provider, subjectOf(row)), start = periodInstant(row.from, "from");
  return list.filter((other) => other !== row && periodSubjectKey(other.provider, subjectOf(other)) === key
    && periodInstant(other.from, "from") < start
    && (other.until == null || periodInstant(other.until, "until") > start));
}
/** A copy of the list with those rows ended at the new row's start. */
function endEarlier<T extends { provider: string; from: string; until?: string | null }>(list: T[], row: T, subjectOf: (row: T) => string): T[] {
  const earlier = new Set(earlierRunningInto(list, row, subjectOf));
  return list.map((other) => earlier.has(other) ? { ...other, until: row.from } : other);
}

function prepareEdit(ctx: AccountPeriodsContext, edit: PeriodEdit): PreparedEdit {
  const root = archiveRootOf(ctx), loaded = loadDeclarations(declarationsFileOf(ctx));
  if (edit.revision !== loaded.revision) throw new Error(PERIOD_REVISION_MISMATCH);
  if (!loaded.editable) throw new Error(`Plik deklaracji nie jest dokumentem "version": 1, więc edytor go nie nadpisze:\n${loaded.errors.join("\n")}`);
  const table: PeriodTable = edit.kind === "account" ? ACCOUNT_PERIODS : PLAN_PERIODS;
  const observed = loadPeriodRows(ctx.sqlite, table).filter((row) => row.origin === "observed");
  const preview: PeriodEditPreview = { events: null, overrides: [], errors: [], endEarlier: null };
  let document: PeriodDeclarationsFile;
  if (edit.kind === "account") {
    const row = edit.row === null ? null : accountRow(edit.row), list = [...(loaded.document.accounts ?? [])];
    spliceRow(list, edit.replace ? { subject: edit.replace.source, from: edit.replace.from } : null, row, (r) => r.source);
    const earlier = row ? earlierRunningInto(list, row, (r) => r.source) : [];
    const ended = row && earlier.length ? endEarlier(list, row, (r) => r.source) : list;
    if (row && earlier.length) preview.endEarlier = { rows: earlier.map((r) => ({ value: r.account, from: r.from, until: r.until ?? null })),
      errors: parsePeriodDeclarations(JSON.stringify({ ...loaded.document, accounts: ended })).errors };
    document = { ...loaded.document, accounts: edit.end_earlier ? ended : list };
    if (row) {
      preview.events = eventsInRange(ctx.sqlite, root, row.source, row.from, row.until ?? null);
      preview.overrides = overridesOf(observed, row.provider, row.source, row.from, row.until ?? null, row.account);
    }
  } else {
    const row = edit.row === null ? null : planRow(edit.row), list = [...(loaded.document.plans ?? [])];
    spliceRow(list, edit.replace ? { subject: edit.replace.account, from: edit.replace.from } : null, row, (r) => r.account);
    const earlier = row ? earlierRunningInto(list, row, (r) => r.account) : [];
    const ended = row && earlier.length ? endEarlier(list, row, (r) => r.account) : list;
    if (row && earlier.length) preview.endEarlier = { rows: earlier.map((r) => ({ value: r.plan, from: r.from, until: r.until ?? null })),
      errors: parsePeriodDeclarations(JSON.stringify({ ...loaded.document, plans: ended })).errors };
    document = { ...loaded.document, plans: edit.end_earlier ? ended : list };
    if (row) preview.overrides = overridesOf(observed, row.provider, row.account, row.from, row.until ?? null, row.plan);
    // The billing cycles recomputed are those of this account from the earliest start the edit touches (§8).
    const replaced = edit.replace ? (loaded.document.plans ?? []).find((r) => normEraKey(r.account) === normEraKey(edit.replace!.account)
      && instantOrNull(r.from) === instantOrNull(edit.replace!.from)) : undefined;
    const starts = [row?.from, row?.anchor, replaced?.from, replaced?.anchor ?? undefined, edit.replace?.from]
      .flatMap((value) => value ? [instantOrNull(value)] : []).filter((value): value is number => value !== null);
    const subject = row ?? replaced;
    if (subject && starts.length) preview.billing = { provider: normEraVendor(subject.provider), account: subject.account,
      from: new Date(Math.min(...starts)).toISOString() };
  }
  // The file is validated as a whole: a row that overlaps another declaration of its subject is refused.
  preview.errors = parsePeriodDeclarations(JSON.stringify(document)).errors;
  return { document, preview };
}

export function previewPeriodEdit(ctx: AccountPeriodsContext, edit: PeriodEdit): PeriodEditPreview {
  return prepareEdit(ctx, edit).preview;
}

export function applyPeriodEdit(ctx: AccountPeriodsContext, edit: PeriodEdit): PeriodEditResult {
  const file = declarationsFileOf(ctx), { document, preview } = prepareEdit(ctx, edit);
  if (preview.errors.length) throw new Error(preview.errors.join("\n"));
  // No await between the revision check and the atomic replacement in this process.
  atomicArchiveWrite(file, JSON.stringify(document, null, 2) + "\n");
  let applied = false;
  try {
    applied = applyPeriodDeclarations(ctx.sqlite, file).errors.length === 0;
  } catch (error) {
    // A writer holds the database. The file is saved; the 60 s feed brings the tables in line.
    console.warn("[tokenAtlas account periods] saved the declarations file, tables follow later:", error);
  }
  return { preview, applied, view: buildAccountPeriodsView(ctx) };
}
