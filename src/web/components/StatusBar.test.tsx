import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CreditNotices, StatusBar, statusLine, type StatusBarProps } from "./StatusBar";
import type { CreditNoticeView } from "../../shared/credit-notices";
import { setMissingRates } from "../lib/missing-rate";
import { setLanguage, translateForLanguage, type MessageTranslator } from "../lib/i18n";
import type { AnalysisRebuildJob, AtlasBootstrapStatus, SyncStatus } from "../lib/api";
import type { AppActivity as Snapshot } from "../../shared/app-activity";
import { backgroundTasks, overallFraction } from "../lib/progress";

const t: MessageTranslator = (en, pl, values) => translateForLanguage("en", en, pl, values);
const job: AnalysisRebuildJob = {
  generation: 12, scope: "all", range: null, state: "running", error: null,
  phase: "reports", completed: 7, total: 20, requestedAt: "2026-09-18T10:00:00Z",
};
const idle = { running: false, run: null, finished_at: "2026-09-30T06:22:18.194Z" } as unknown as SyncStatus;
const noActivity = { data: null, unavailable: false };
const line = (overrides: Partial<Parameters<typeof statusLine>[0]> = {}) => statusLine({ sync: idle, syncUnavailable: false,
  rebuild: { job: null, unavailable: false }, waitingForSubscriptions: false, activity: noActivity, staleAt: null, t, ...overrides });
const props: StatusBarProps = { sync: idle, syncUnavailable: false, syncObservedAt: null, rebuild: { job: null, unavailable: false },
  waitingForSubscriptions: false, stickyTop: 52, onOpenSettings: () => {} };
const render = (overrides: Partial<StatusBarProps> = {}) => renderToStaticMarkup(<StatusBar {...props} {...overrides} />);

test("the bar is always present, and an idle application says its data is current", () => {
  const html = render();
  expect(html).toContain("Data up to date");
  expect(html).toContain("last synchronization");
  expect(html).toContain('role="progressbar"');
  expect(html).not.toContain("aria-valuenow");
});

test("a rebuild's reports step shows its measured count; queued steps never invent a percentage", () => {
  const html = render({ rebuild: { job, unavailable: false } });
  expect(html).toContain("Data rebuild · 3/3 Reports");
  expect(html).toContain("7 / 20 reports");
  expect(html).toContain('aria-valuenow="7"');
  expect(html).toContain('aria-valuemax="20"');
  expect(html).toContain("width:35%");
  for (const phase of ["sources", "summaries", "reports"] as const) {
    const queued = render({ rebuild: { job: { ...job, phase, state: "queued", completed: undefined, total: undefined }, unavailable: false } });
    expect(queued).toContain("waiting for current data writes to finish");
    expect(queued).not.toContain("aria-valuenow");
  }
});

test("reports waiting for prices name the providers still being prepared", () => {
  const stage = { state: "replay" as const, version: 8, checkpoint: null, cursor: 1, lastProgressAt: null, etaMs: null };
  const data: Snapshot = { observedAt: 1, observationStartedAt: 1, unavailable: false, busy: true,
    providers: [{ provider: "codex", register: stage, facts: null }], reports: { pending: 0, failed: 0, truncated: false, views: [] }, progress: [] };
  expect(line({ rebuild: { job: { ...job, total: undefined, completed: 0 }, unavailable: false }, activity: { data, unavailable: false } }).detail)
    .toContain("waiting for prepared prices: codex");
});

test("the source step of a rebuild shows the synchronization itself, labelled with the rebuild", () => {
  const progress = { phase: "publish", vendor: "codex", startedAt: "2026-09-18T10:00:00Z", completed: 11, total: 42 } as const;
  const write = { scope: "sync:codex", step: "publish.write", label: "Transferring records", done: 400, total: 800, unit: "records",
    startedAt: "2026-09-18T10:00:00Z", updatedAt: "2026-09-18T10:00:00Z" } as const;
  const running = { running: true, started_at: "2026-09-18T10:00:00Z", progress: [write],
    run: { rebuildGeneration: 12, progress, scope: { kind: "all" }, mode: "full", vendors: [], trigger: "manual" } } as unknown as SyncStatus;
  const html = render({ sync: running, rebuild: { job: { ...job, phase: "sources" }, unavailable: false } });
  expect(html).toContain("Data rebuild · 1/3 Source files · Full update");
  expect(html).toContain("400 / 800 records · 50%");
  expect(render({ sync: running, rebuild: { job: { ...job, generation: 13, phase: "sources" }, unavailable: false } }))
    .not.toContain("Data rebuild");
  // The running synchronization keeps the column details: its sources in the state column, events beside them.
  expect(html).toContain("status-details-columns");
  expect(html.indexOf('data-sync-vendor="codex"')).toBeGreaterThan(html.indexOf("status-details-state"));
  expect(html).toContain("data-status-events");
});

test("failures stay visible in the bar instead of implying ongoing success", () => {
  const failed = render({ rebuild: { job: { ...job, state: "error", error: "Missing archived source" }, unavailable: false } });
  expect(failed).toContain("Data rebuild stopped");
  expect(failed).toContain("Missing archived source");
  expect(failed).toContain("Open rebuild settings");
  const sync = { ...idle, run: { status: "failure", error: "Sync setup failed: disk full", finishedAt: null } } as unknown as SyncStatus;
  expect(line({ sync })).toMatchObject({ tone: "error", title: "Last synchronization failed" });
  expect(line({ sync }).detail).toContain("disk full");
  expect(line({ sync: { ...idle, run: { status: "partial_success" } } as unknown as SyncStatus }).tone).toBe("warn");
  expect(line({ sync: null, syncUnavailable: true })).toMatchObject({ tone: "unknown", title: "Status unavailable" });
});

test("startup names its stage and the full safety ingest", () => {
  const bootstrap = { running: true, stage: "incremental-catch-up", status: "full-ingest-required", started_at: "2026-09-30T06:11:00Z",
    attempts: [] } as unknown as AtlasBootstrapStatus;
  const result = line({ sync: { ...idle, bootstrap } as SyncStatus });
  expect(result.title).toBe("Preparing the local Atlas index");
  expect(result.detail).toContain("Incremental synchronization · stage 6/6");
  expect(result.detail).toContain("full safety ingest");
});

test("background preparation shows each producer's register entry; without entries it names the providers", () => {
  const stage = (state: "backfill" | "ready") => ({ state, version: null, checkpoint: null, cursor: null, lastProgressAt: null, etaMs: null });
  const entry = (scope: string, step: string, done: number, total: number | null, unit: "files" | "readings") =>
    ({ scope, step, label: step, done, total, unit, startedAt: "2026-10-04T10:00:00Z", updatedAt: "2026-10-04T10:00:01Z" });
  const base = { observedAt: 1, observationStartedAt: 1, busy: true, unavailable: false,
    reports: { pending: 0, failed: 0, truncated: false, views: [] },
    providers: [{ provider: "codex", register: stage("backfill"), facts: null }, { provider: "claude", register: stage("backfill"), facts: null }] };
  const data = { ...base, progress: [entry("codex-ledger", "copies", 1234, 15945, "files"),
    entry("account-periods", "feed", 500, 1000, "readings"), entry("sync:codex", "parse", 1, 2, "files")] } as Snapshot;
  const background = data.progress.filter(item => !item.scope.startsWith("sync"));
  const seen = new Map<string, number>();
  const overall = overallFraction(background, seen);
  const tasks = backgroundTasks(background, seen, new Map());
  expect(tasks.map(task => task.name)).toEqual(["Prices Codex", "Account periods"]); // furthest first
  const result = line({ activity: { data, unavailable: false }, overall, tasks });
  expect(result.title).toBe("Preparing data in the background");
  // One short line: finished of all tasks and the share of the whole; producers and steps are in the details.
  expect(result.detail).toBe(`0 of 2 tasks · ~${Math.floor(overall! * 100)}%`);
  expect(result.progress).toEqual({ completed: Math.floor(overall! * 100), total: 100 });
  const named = line({ activity: { data: { ...base, progress: [] } as Snapshot, unavailable: false } });
  expect(named.detail).toBe("prices: Codex, Claude");
  expect(named.progress).toBe("indeterminate");
  // A finished task stays counted, and a failed view is named after the count.
  const gone = backgroundTasks([], seen, new Map([["account-periods", "Account periods"], ["codex-ledger", "Prices Codex"]]));
  const failed = { ...base, reports: { pending: 0, failed: 1, truncated: false, views: [{ view: "capacity", pending: 0, failed: 1 }] } } as Snapshot;
  expect(line({ activity: { data: failed, unavailable: false }, overall: 1, tasks: gone }).detail).toBe("2 of 2 tasks · ~100% · Capacity: 1 failed");
});

test("a model without a price turns the current state into one alert line that sends the user to Settings", () => {
  const missingRates = { tokens: 2_300_000_000, models: [{ model: "gpt-new-sol", observed_provider: "openai", rate_vendor: "openai", tokens: 2_300_000_000 }] };
  const pl = (_en: string, plText: string) => plText;
  setLanguage("pl");
  try {
    const alert = line({ missingRates, t: pl });
    expect(alert.tone).toBe("warn");
    expect(alert.title).toBe("Nowy model bez ceny");
    expect(alert.detail).toContain("gpt-new-sol (2,3 mld tokenów) — wpisz cenę w Ustawieniach → Cenniki → Modele");
    expect(alert.detail).toContain("ostatnia synchronizacja");
  } finally { setLanguage("en"); }
  // A more urgent state keeps the bar; the alert waits in the details.
  const failed = { ...idle, run: { status: "failure", error: "disk full", finishedAt: null } } as unknown as SyncStatus;
  expect(line({ sync: failed, missingRates }).title).toBe("Last synchronization failed");
  expect(line({ missingRates: { tokens: 0, models: [] } }).title).toBe("Data up to date");
  // A partial synchronization stays named, but the missing price is the line.
  const partial = line({ sync: { ...idle, run: { status: "partial_success" } } as unknown as SyncStatus, missingRates });
  expect(partial).toMatchObject({ tone: "warn", title: "New model without a price" });
  expect(partial.detail).toContain("last synchronization completed with issues (details)");

  setMissingRates(missingRates);
  try {
    const html = render();
    expect(html).toContain("New model without a price");
    expect(html).toContain("gpt-new-sol (2.3B tokens) — enter the price in Settings → Price lists → Models");
    expect(html).toContain("data-missing-rate-alert");
    expect(html).toContain("Open Price lists → Models");
    // Events sit in the right column, after the state column.
    expect(html.indexOf("data-missing-rate-alert")).toBeGreaterThan(html.indexOf("data-status-events"));
    expect(html).not.toContain("No new events");
  } finally { setMissingRates(null); }
  expect(render()).not.toContain("data-missing-rate-alert");
  expect(render()).toContain("No new events");
});

const expiring: CreditNoticeView = { id: 7, provider: "claude", account: "max-1", label: "Claude Max", pool: "claude:g@2026-11-05T12:00:00.000Z",
  kind: "expiring", unit: "usd", amount: 150, amount_text: null, expires_at: "2026-11-05T12:00:00Z", observed_at: "2026-10-24T10:00:00Z",
  detail: { stage: "14d", granted: 250, remaining: 200, pace_per_day: 5, days_left: 12 } };
const received: CreditNoticeView = { ...expiring, id: 8, kind: "received", amount: 250, detail: {} };
const creditNow = Date.parse("2026-10-24T12:00:00Z");

test("a package about to expire unused takes the line after a missing price; arrivals extend Data up to date", () => {
  const warned = line({ creditNotices: [expiring, received], now: creditNow });
  expect(warned).toMatchObject({ tone: "warn", title: "A package will expire unused" });
  expect(warned.detail).toStartWith("Claude Max: at the current pace about $150 of $200 will be lost on Nov 5 (in 12 days) · last synchronization");
  const missingRates = { tokens: 1, models: [{ model: "gpt-new-sol", observed_provider: "openai", rate_vendor: "openai", tokens: 1 }] };
  expect(line({ creditNotices: [expiring], missingRates, now: creditNow }).title).toBe("New model without a price");
  const arrived = line({ creditNotices: [received], now: creditNow });
  expect(arrived).toMatchObject({ tone: "ok", title: "Data up to date" });
  expect(arrived.detail).toEndWith(" · new package: Claude Max $250");
  const failed = { ...idle, run: { status: "failure", error: "boom" } } as unknown as SyncStatus;
  expect(line({ sync: failed, creditNotices: [expiring], now: creditNow }).title).toBe("Last synchronization failed");
});

test("the details list every open notice with its actions", () => {
  const html = renderToStaticMarkup(<CreditNotices notices={[expiring, received]} now={creditNow} onOpenAccount={() => {}} onRead={() => {}} />);
  expect(html).toContain("Packages");
  expect(html).toContain("Will expire unused");
  expect(html).toContain("New package");
  expect(html.match(/Open subscription/g)).toHaveLength(1);
  expect(html).toContain("Mark as read");
});

test("an expired sign-in is a warning line per account and computer, before a missing price", async () => {
  const { setProbeNotices } = await import("../lib/probe-notices");
  const since = new Date(new Date().setHours(3, 20, 0, 0)).toISOString();
  const notice = { provider: "claude", subject: "claude-1", account: null, machine: "EXAMPLE-LAPTOP-A", code: "login-expired" as const,
    since, failed_at: new Date().toISOString() };
  const missingRates = { tokens: 10, models: [{ model: "gpt-new-sol", observed_provider: "openai", rate_vendor: "openai", tokens: 10 }] };
  const pl = (_en: string, plText: string) => plText;
  setLanguage("pl");
  try {
    const one = line({ probeNotices: [notice], missingRates, t: pl });
    expect(one).toMatchObject({ tone: "warn", title: "Claude na EXAMPLE-LAPTOP-A: logowanie wygasło" });
    expect(one.detail).toBe("odczyty limitu wstrzymane od 03:20 — uruchom `claude` w terminalu i zaloguj się (/login)");
    const two = line({ probeNotices: [notice, { ...notice, machine: "EXAMPLE-MAIN" }], t: pl });
    expect(two.detail).toContain("· i 1 więcej (szczegóły)");
  } finally { setLanguage("en"); }
  const en = line({ probeNotices: [notice] });
  expect(en.title).toBe("Claude on EXAMPLE-LAPTOP-A: sign-in expired");
  expect(en.detail).toMatch(/^limit readings paused since 03:20( AM)? — run `claude` in a terminal and sign in \(\/login\)$/);
  // A failed synchronization still comes first; no notice leaves the current state alone.
  const failed = { ...idle, run: { status: "failure", error: "disk full", finishedAt: null } } as unknown as SyncStatus;
  expect(line({ sync: failed, probeNotices: [notice] }).title).toBe("Last synchronization failed");
  expect(line({ probeNotices: [] }).title).toBe("Data up to date");

  setProbeNotices([notice, { ...notice, machine: "EXAMPLE-MAIN", code: "login-mismatch" }]);
  try {
    const html = render();
    expect(html).toContain("data-probe-notices");
    expect(html.match(/data-probe-notice[ =>]/g)).toHaveLength(2);
    expect(html).toContain("Claude on EXAMPLE-MAIN: signed in to another account");
    expect(html).toContain("sign in to this subscription&#x27;s account (`claude`, /login)");
  } finally { setProbeNotices(null); }
  expect(render()).not.toContain("data-probe-notices");
});

test("a sign-in notice of this computer offers Connect Claude; another computer's does not", async () => {
  const { setProbeNotices } = await import("../lib/probe-notices");
  const { resetClaudeLogins, setClaudeLogins } = await import("../lib/claude-login");
  const notice = { provider: "claude", subject: "claude-1", account: null, machine: "EXAMPLE-LAPTOP-A", code: "login-missing" as const,
    since: null, failed_at: new Date().toISOString() };
  const login = { subject: "claude-1", profile: "C:\\Users\\u\\.claude", state: "running" as const, url: "https://claude.com/cai/oauth/authorize?state=s",
    browser_opened: true, reason: null, exit_code: null, detail: null, started_at: "2026-10-10T10:00:00Z", finished_at: null };
  setProbeNotices([notice, { ...notice, machine: "EXAMPLE-MAIN" }, { ...notice, provider: "codex", subject: "codex-1" }]);
  try {
    // The computer's name is unknown until the first read: no control yet.
    expect(render()).not.toContain("Connect Claude");
    setClaudeLogins({ machine: "example-laptop-a", logins: [] });
    let html = render();
    expect(html.match(/Connect Claude/g)).toHaveLength(1);
    expect(html).toContain("data-claude-connect");
    setClaudeLogins({ machine: "EXAMPLE-LAPTOP-A", logins: [login] });
    html = render();
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Waiting for the browser…<\/button>/);
    // The CLI opens the browser itself; its printed page (a paste-code flow) is never offered.
    setClaudeLogins({ machine: "EXAMPLE-LAPTOP-A", logins: [{ ...login, browser_opened: false }] });
    expect(render()).not.toContain("href=");
    setClaudeLogins({ machine: "EXAMPLE-LAPTOP-A", logins: [{ ...login, state: "failed", reason: "timeout", finished_at: "2026-10-10T10:10:00Z" }] });
    html = render();
    expect(html).toContain("Connect Claude");
    expect(html).toContain("sign-in timed out");
    setLanguage("pl");
    expect(render()).toContain("Połącz Claude");
    // A failure a new sign-in does not cure gets no control.
    setProbeNotices([{ ...notice, code: "login-save-failed" as const }]);
    expect(render()).not.toContain("Połącz Claude");
  } finally { setLanguage("en"); setProbeNotices(null); resetClaudeLogins(); }
});
