import type { ProgressEntry, ProgressUnit } from "../../shared/progress";
import { getLocale, translate } from "./i18n";

/** How the screen names the progress register's steps; a step it does not know keeps the server's label. */
const STEP_LABELS: Record<string, [string, string]> = {
  readings: ["Reading current account limits", "Odczytuję bieżące limity kont"],
  listing: ["Looking for changed files", "Szukam zmienionych plików"],
  "archive-check": ["Checking archived copies", "Sprawdzam kopie w archiwum"],
  "limit-scan": ["Checking files for limit messages", "Sprawdzam pliki pod kątem komunikatów o limitach"],
  select: ["Selecting changed files", "Wybieram zmienione pliki"],
  verify: ["Verifying file contents", "Weryfikuję zawartość plików"],
  copy: ["Copying originals", "Kopiuję oryginały"],
  discover: ["Collecting file list", "Zbieram listę plików"],
  parse: ["Reading files", "Czytam pliki"],
  scan: ["Checking sources for changes", "Sprawdzam zmiany w źródłach"],
  identity: ["Checking account assignments", "Sprawdzam przypisania kont"],
  mirror: ["Copying source files", "Kopiuję pliki źródłowe"],
  stage: ["Preparing the import", "Przygotowuję import"],
  ingest: ["Indexing history", "Indeksuję historię"],
  validate: ["Validating imported data", "Sprawdzam zaimportowane dane"],
  publish: ["Saving imported data", "Zapisuję zaimportowane dane"],
  attribution: ["Assigning usage to accounts", "Przypisuję zużycie do kont"],
  projects: ["Updating project assignments", "Aktualizuję przypisania projektów"],
  checkpoint: ["Flushing database changes", "Utrwalam zmiany w bazie"],
  finalize: ["Publishing account state", "Publikuję stan kont"],
  "validate.sources": ["Checking source coverage", "Sprawdzam kompletność źródeł"],
  "validate.identities": ["Preserving source identities", "Uzgadniam tożsamości źródeł"],
  "validate.repos": ["Assigning repositories", "Przypisuję repozytoria"],
  "validate.gaps": ["Calculating gaps between calls", "Obliczam odstępy między wywołaniami"],
  "validate.projects": ["Assigning projects", "Przypisuję projekty"],
  "validate.rules": ["Saving calculation rules", "Zapisuję reguły obliczeń"],
  "validate.integrity": ["Checking database structure", "Kontroluję strukturę bazy"],
  "validate.timestamps": ["Checking event dates", "Sprawdzam daty zdarzeń"],
  "publish.compare": ["Comparing source records", "Porównuję rekordy źródłowe"],
  "publish.write": ["Transferring records", "Przenoszę rekordy"],
  "publish.finalize": ["Saving the change summary", "Utrwalam podsumowanie zmian"],
  "publish.indexes": ["Building indexes", "Buduję indeksy"],
  "publish.commit": ["Committing the result", "Zatwierdzam wynik"],
  backfill: ["building history", "przygotowanie historii"],
  resolve: ["resolving accounts", "przypisywanie kont"],
  revalue: ["revaluing", "ponowna wycena"],
  reconcile: ["applying changes", "nanoszenie zmian"],
  copies: ["valuing source files", "wycena plików źródłowych"],
  aggregates: ["updating sums", "aktualizacja sum"],
  feed: ["reading limit readings", "odczyty limitów"],
  windows: ["dividing limit windows", "podział okien limitów"],
  "fill.copies": ["registering source files", "rejestracja plików źródłowych"],
  "fill.events": ["valuing calls", "wycena wywołań"],
  "fill.canonical": ["resolving copies", "rozstrzyganie kopii"],
  sums: ["summing limit windows", "sumowanie okien limitów"],
};

const UNIT_LABELS: Record<ProgressUnit, [string, string]> = {
  files: ["files", "plików"], records: ["records", "rekordów"], indexes: ["indexes", "indeksów"],
  tables: ["data sets", "zbiorów"], changes: ["changes", "zmian"], readings: ["readings", "odczytów"],
  accounts: ["accounts", "kont"], sources: ["sources", "źródeł"], days: ["days", "dni"], items: ["items", "elementów"],
};

const VENDOR_NAMES: Record<string, string> = { codex: "Codex", claude: "Claude", gemini: "Gemini", grok: "Grok", glm: "GLM", opencode: "OpenCode" };

/** How the screen names each background producer (server/background-jobs.ts, background-progress.ts). */
const TASK_NAMES: Record<string, [string, string]> = {
  "account-periods": ["Account periods", "Okresy kont"],
  "limit-windows": ["Limit windows", "Okna limitów"],
  "window-usage": ["Window usage", "Zużycie w oknach"],
  "archive-verification": ["Archive", "Archiwum"],
  "current-projection": ["Current limits", "Bieżące limity"],
  "claude-card-metadata": ["Claude cards", "Karty Claude"],
  "capacity-cycle-results": ["Capacity cycles", "Cykle pojemności"],
  "window-point-values": ["Window point values", "Wycena punktów okien"],
  "subscription-capacities": ["Subscription capacity", "Pojemność abonamentów"],
  "window-end-causes": ["Window end causes", "Przyczyny końca okien"],
  "subscription-hours": ["Active agent time", "Aktywny czas agentów"],
  "project-plan-facts": ["Project plans", "Plany projektów"],
  "billing-cycles": ["Billing cycles", "Cykle rozliczeniowe"],
  "gauge-journal": ["Limit readings to archive", "Odczyty limitów do archiwum"],
};

/** The background producer an entry belongs to; synchronization scopes have their own row. */
function scopeLabel(scope: string): string | null {
  if (scope === "sync" || scope.startsWith("sync:")) return null;
  const [kind, provider] = scope.split(":");
  if (kind === "usage-ledger" || kind === "codex-ledger") return `${translate("Prices", "Ceny")} ${VENDOR_NAMES[provider ?? "codex"] ?? provider}`;
  const name = TASK_NAMES[kind!];
  return name ? translate(...name) : null;
}

/** A background task's display name; an unknown producer keeps the server's step label instead of its id. */
export function taskName(entry: Pick<ProgressEntry, "scope" | "label">): string {
  const name = scopeLabel(entry.scope);
  if (name) return name;
  return entry.label ? entry.label.charAt(0).toLocaleUpperCase() + entry.label.slice(1) : entry.scope;
}

export const isSyncScope = (entry: ProgressEntry) => entry.scope === "sync" || entry.scope.startsWith("sync:");

export function progressStepLabel(entry: ProgressEntry): string {
  if (isSyncScope(entry)) { const label = STEP_LABELS[entry.step]; return label ? translate(...label) : entry.label; }
  // Single-step producers are named by their task; only the multi-step ledgers add the step.
  if (!SCOPE_STEPS.some(([matches]) => matches(entry.scope))) return taskName(entry);
  const label = STEP_LABELS[entry.step];
  return `${taskName(entry)}: ${label ? translate(...label) : entry.label}`;
}

/** `done / total unit · NN%`, `done unit` while the total is unknown, nothing before the first item. */
export function progressCounter(entry: ProgressEntry): string | null {
  const format = (value: number) => value.toLocaleString(getLocale());
  const unit = translate(...UNIT_LABELS[entry.unit]);
  if (entry.total !== null && entry.total > 0)
    return `${format(entry.done)} / ${format(entry.total)} ${unit} · ${Math.floor(entry.done / entry.total * 100)}%`;
  return entry.done > 0 ? `${format(entry.done)} ${unit}` : null;
}

/** A provider's display name; an unknown id stays as it is. */
export const vendorName = (provider: string): string => VENDOR_NAMES[provider] ?? provider;

/** Steps of a scope in the order it runs them (background-progress.ts); a scope not listed has one step. */
const SCOPE_STEPS: Array<[(scope: string) => boolean, readonly string[]]> = [
  [scope => scope.startsWith("usage-ledger:"), ["backfill", "resolve", "revalue", "reconcile", "activity"]],
  [scope => scope === "codex-ledger", ["fill.copies", "fill.events", "fill.canonical", "fill.gaps", "copies", "aggregates"]],
];

/** How far one scope got, 0..1: its finished steps plus the share of the current one (0 while its total is unknown). */
export function scopeFraction(entry: ProgressEntry): number {
  const share = entry.total !== null && entry.total > 0 ? Math.min(1, Math.max(0, entry.done / entry.total)) : 0;
  const steps = SCOPE_STEPS.find(([matches]) => matches(entry.scope))?.[1];
  const index = steps?.indexOf(entry.step) ?? -1;
  return steps && index >= 0 ? (index + share) / steps.length : share;
}

/**
 * The share of the background work done, 0..1, as the plain mean of its scopes. `seen` remembers the scopes of
 * the current stretch of work: one that has left the register finished, so it counts as done instead of
 * pulling the share down. Null without any scope.
 */
export function overallFraction(entries: readonly ProgressEntry[], seen: Map<string, number>): number | null {
  const present = new Set(entries.map(entry => entry.scope));
  for (const scope of seen.keys()) if (!present.has(scope)) seen.set(scope, 1);
  for (const entry of entries) seen.set(entry.scope, scopeFraction(entry));
  if (!seen.size) return null;
  return [...seen.values()].reduce((sum, value) => sum + value, 0) / seen.size;
}

/** The text of one entry: `label · done / total unit · NN%`. */
export function progressText(entry: ProgressEntry): string {
  const counter = progressCounter(entry);
  return counter ? `${progressStepLabel(entry)} · ${counter}` : progressStepLabel(entry);
}

/** One background producer of the current stretch of work; `entry` is null once it left the register (done). */
export type BackgroundTask = { scope: string; name: string; entry: ProgressEntry | null; fraction: number };

/**
 * The tasks of the current stretch (`seen`, kept by `overallFraction`): counted ones first, then the ones
 * still waiting without a count, then the finished ones. `names` keeps the name of a task that already left.
 */
export function backgroundTasks(entries: readonly ProgressEntry[], seen: ReadonlyMap<string, number>, names: Map<string, string>): BackgroundTask[] {
  for (const entry of entries) names.set(entry.scope, taskName(entry));
  const rank = (task: BackgroundTask) => !task.entry ? 2 : task.entry.total !== null && task.entry.total > 1 ? 0 : 1;
  return [...seen.entries()].map(([scope, fraction]) => ({ scope, fraction,
    entry: entries.find(entry => entry.scope === scope) ?? null, name: names.get(scope) ?? scope }))
    .sort((a, b) => rank(a) - rank(b) || b.fraction - a.fraction || a.name.localeCompare(b.name));
}
