import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RemapStatus, SyncRunResult, SyncStatus } from "../lib/api";
import type { ProgressEntry } from "../../shared/progress";
import { RemapActivity, StartupActivity, SyncActivity } from "./SyncActivity";

function run(over: Partial<SyncRunResult> = {}): SyncRunResult {
  return {
    runId: "run-1",
    trigger: "manual",
    scope: { kind: "all" },
    mode: "incremental",
    startedAt: "2026-09-01T10:00:00.000Z",
    finishedAt: null,
    status: "running",
    beforeRevisions: {
      data: 4,
      config: 2,
      vendors: { codex: 2, claude: 1, opencode: 0, grok: 0, gemini: 0, gauges: 0 },
    },
    afterRevisions: {
      data: 4,
      config: 2,
      vendors: { codex: 2, claude: 1, opencode: 0, grok: 0, gemini: 0, gauges: 0 },
    },
    aggregateWorkRequested: false,
    vendors: [
      {
        vendor: "codex",
        status: "success",
        processedInputs: 1,
        skippedInputs: 0,
        writtenRows: 2,
        dirtyRange: null,
        dataChanged: true,
        error: null,
        diagnostics: {},
        startedAt: "2026-09-01T10:00:00.000Z",
        finishedAt: "2026-09-01T10:00:01.000Z",
      },
      {
        vendor: "claude",
        status: "pending",
        processedInputs: 0,
        skippedInputs: 0,
        writtenRows: 0,
        dirtyRange: null,
        dataChanged: false,
        error: null,
        diagnostics: {},
        startedAt: "2026-09-01T10:00:01.000Z",
        finishedAt: null,
      },
    ],
    error: null,
    ...over,
  };
}

function sync(over: Partial<SyncStatus> = {}): SyncStatus {
  return {
    running: true,
    trigger: "manual",
    mode: "incremental",
    started_at: new Date().toISOString(),
    finished_at: null,
    exit_code: null,
    ok: null,
    phase: "Indeksuję użycie OpenCode",
    phase_index: 4,
    phase_count: 8,
    log_tail: [],
    run: run(),
    ...over,
  };
}

function entry(scope: string, step: string, done: number, total: number | null, unit: ProgressEntry["unit"]): ProgressEntry {
  return { scope, step, label: step, done, total, unit, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

function remap(over: Partial<RemapStatus> = {}): RemapStatus {
  return {
    running: true,
    why: "assignment rules changed since the last remap",
    started_at: new Date().toISOString(),
    finished_at: null,
    exit_code: null,
    ok: null,
    log_tail: [],
    message: "Wyliczam odstępy w oc_events",
    progress: {
      phase: "gaps",
      phase_index: 2,
      phase_count: 4,
      message: "Wyliczam odstępy w oc_events",
    },
    tables: {},
    rows: {},
    ...over,
  };
}

describe("SyncActivity", () => {
  it("shows publication row counts separately from final commit", () => {
    const progress={phase:"publish" as const,vendor:"codex",completed:11,total:42,startedAt:new Date().toISOString()};
    const html=renderToStaticMarkup(<SyncActivity sync={sync({run:run({progress}),progress:[entry("sync:codex","publish.write",400,800,"records")]})} />);
    expect(html).toContain("Transferring records · 400 / 800 records · 50%");
    expect(html).toContain("400 / 800 records · 50% · 11/42 steps");
    const commit=renderToStaticMarkup(<SyncActivity sync={sync({run:run({progress}),progress:[entry("sync:codex","publish.commit",0,null,"items")]})} />);
    expect(commit).toContain("Committing the result");
    expect(commit).not.toContain("400 / 800");
  });
  it("names the validation step with its data set counter", () => {
    const progress = {phase:"validate" as const,vendor:"codex",completed:10,total:42,startedAt:new Date().toISOString()};
    const html = renderToStaticMarkup(<SyncActivity sync={sync({run:run({progress}),progress:[entry("sync:codex","validate.gaps",2,4,"tables")]})} />);
    expect(html).toContain("Calculating gaps between calls · 2 / 4 data sets · 50%");
    const integrity = renderToStaticMarkup(<SyncActivity sync={sync({run:run({progress}),progress:[entry("sync:codex","validate.integrity",0,null,"tables")]})} />);
    expect(integrity).toContain("Checking database structure");
    expect(integrity).not.toContain("2 / 4");
  });
  it("shows file discovery until the denominator is known", () => {
    const progress = {phase:"ingest" as const,vendor:"codex",completed:2,total:42,startedAt:new Date().toISOString()};
    const discover = (found:number) => renderToStaticMarkup(<SyncActivity sync={sync({run:run({progress}),progress:[entry("sync:codex","discover",found,null,"files")]})} />);
    expect(discover(0)).toContain("Codex: Collecting file list");
    expect(discover(18)).toContain("Codex: Collecting file list");
    expect(discover(18)).toContain("Collecting file list · 18 files");
    expect(discover(18)).toContain("2/42 steps");
    const known = renderToStaticMarkup(<SyncActivity sync={sync({run:run({progress}),progress:[entry("sync:codex","parse",1,20,"files")]})} />);
    expect(known).toContain("Reading files · 1 / 20 files · 5%");
    expect(known).not.toContain("Collecting file list");
  });
  it("every vendor row shows its own register entry while the run works", () => {
    const active = run({progress:{phase:"ingest",vendor:"claude",completed:3,total:18,startedAt:new Date().toISOString()}});
    const html = renderToStaticMarkup(<SyncActivity sync={sync({run:active,progress:[
      entry("sync:claude","parse",2,8,"files"),entry("sync:gauges","copy",5,null,"files")]})} />);
    expect(html).toContain("Reading files · 2 / 8 files · 25%");
    expect(html).toContain("Copying originals · 5 files");
    expect(html).toContain("2 / 8 files · 25% · 3/18 steps");
    // Entries of a finished run are not progress.
    const finished = renderToStaticMarkup(<SyncActivity sync={sync({running:false,ok:true,run:active,progress:[entry("sync:claude","parse",2,8,"files")]})} />);
    expect(finished).not.toContain("2 / 8 files");
  });
  it("background producers appear in the detail line", () => {
    const html = renderToStaticMarkup(<SyncActivity sync={sync({progress:[entry("usage-ledger:claude","backfill",10,40,"changes")]})} />);
    expect(html).toContain("Prices Claude: building history · 10 / 40 changes · 25%");
  });
  it("keeps sources queued until the initial account reads and scan finish", () => {
    for (const phase of ["readings", "scan"] as const) {
      const html = renderToStaticMarkup(<SyncActivity sync={sync({ run: run({ vendors: [],
        progress: { phase, completed: 0, total: 0, startedAt: new Date().toISOString() } }) })} />);
      expect(html).toContain('aria-valuenow="0"');
      expect(html).not.toContain("unchanged");
      expect(html).not.toContain("Finalizing revisions");
    }
  });

  it("reports the real final phase and remaining steps after every source is done", () => {
    const html = renderToStaticMarkup(<SyncActivity sync={sync({ run: run({
      vendors: run().vendors.map(vendor => ({ ...vendor, status: "success" })),
      progress: { phase: "projects", completed: 15, total: 18, startedAt: new Date().toISOString() },
    }) })} />);
    expect(html).toContain("15/18 steps");
    expect(html).toContain("Updating project assignments");
    expect(html).toContain("steps remaining (including current): 3");
    expect(html).toContain("Time remaining: unknown");
    expect(html).toContain('aria-valuenow="6"');
    expect(html).toContain('aria-valuemax="7"');
  });

  it("derives the active vendor and progress from the typed coordinator run", () => {
    const html = renderToStaticMarkup(<SyncActivity sync={sync()} />);
    expect(html).toContain("Synchronization · all sources");
    expect(html).toContain("Now: Claude Code");
    expect(html).toContain("5/6");
    expect(html).toContain('aria-valuenow="5"');
    expect(html).toContain('aria-valuemax="7"');
    expect(html).toContain("Expand provider synchronization details");
  });

  it("does not use legacy phase or log text as progress", () => {
    const html = renderToStaticMarkup(<SyncActivity sync={sync({ phase: "FAŁSZYWY ETAP", log_tail: ["FAŁSZYWY LOG"] })} />);
    expect(html).not.toContain("FAŁSZYWY ETAP");
    expect(html).not.toContain("FAŁSZYWY LOG");
  });

  it("shows the exact scope and mode for a scoped full run", () => {
    const scoped = run({ scope: { kind: "vendor", vendor: "grok" }, mode: "full", vendors: [] });
    const html = renderToStaticMarkup(<SyncActivity sync={sync({ mode: "full", run: scoped })} />);
    expect(html).toContain("Full update");
    expect(html).toContain("Full update · Grok");
    expect(html).toContain("0/1");
  });

  it("lists every source and names the one whose files are being checked", () => {
    const scanning = run({
      trigger: "auto",
      scope: { kind: "vendors", vendors: ["codex", "claude", "gemini"] },
      vendors: [],
      progress: { phase: "scan", startedAt: "2026-09-01T10:00:00.000Z", completed: 0, total: 0 },
    });
    const html = renderToStaticMarkup(<SyncActivity sync={sync({ run: scanning, progress: [entry("sync:codex", "verify", 5768, 15918, "files")] })} />);
    for (const vendor of ["codex", "claude", "opencode", "grok", "gemini", "gauges"]) expect(html).toContain(`data-sync-vendor="${vendor}"`);
    expect(html).toContain('data-sync-vendor="codex" data-sync-stage="active"');
    expect(html).toContain("Codex: Verifying file contents");
    expect(html).toContain("Verifying file contents · 5,768 / 15,918 files · 36%");
    expect(html).toContain('data-sync-vendor="claude" data-sync-stage="queued"');
    expect(html).toContain("Waiting for its files to be checked");
    // An automatic run covers only changed sources; the rest are unchanged, not waiting.
    expect(html).toContain('data-sync-vendor="grok" data-sync-stage="skipped"');
    expect(html).not.toContain("Waiting for the previous scope");
    const listing = renderToStaticMarkup(<SyncActivity sync={sync({ run: scanning, progress: [entry("sync", "listing", 120, null, "files")] })} />);
    expect(listing).toContain("Checking source files");
    expect(listing).toContain("Looking for changed files");
    expect(listing).toContain("120 files");
  });

  it("keeps one stable parent title while the active vendor changes", () => {
    const claudeHtml = renderToStaticMarkup(<SyncActivity sync={sync()} />);
    const geminiRun = run({
      vendors: [
        { ...run().vendors[0]!, status: "success" },
        { ...run().vendors[1]!, status: "success", finishedAt: "2026-09-01T10:00:02.000Z" },
        {
          ...run().vendors[1]!,
          vendor: "gemini",
          startedAt: "2026-09-01T10:00:02.000Z",
        },
      ],
    });
    const geminiHtml = renderToStaticMarkup(<SyncActivity sync={sync({ run: geminiRun })} />);
    expect(claudeHtml).toContain("Synchronization · all sources");
    expect(geminiHtml).toContain("Synchronization · all sources");
    expect(geminiHtml).toContain("Now: Gemini");
    expect(geminiHtml).toContain('data-sync-vendor="gemini"');
    expect(geminiHtml).toContain('data-sync-stage="active"');
  });
});

describe("StartupActivity", () => {
  it("names every bootstrap stage required on a new PC", () => {
    const html = renderToStaticMarkup(
      <StartupActivity
        bootstrap={{
          running: true,
          stage: "migration",
          message: "migrating",
          started_at: "2026-09-01T10:00:00.000Z",
          finished_at: null,
          ok: null,
          status: "snapshot-installed",
          selected_snapshot_id: "snapshot-1",
          catch_up_mode: "incremental",
          attempts: [],
          changed_path_rows: 0,
          cleared_bookmarks: 0,
          error: null,
        }}
      />
    );
    for (const label of ["Find Atlas snapshot", "Validate compatibility", "Install index", "Database migrations", "Rebase paths", "Incremental synchronization"]) {
      expect(html).toContain(label);
    }
  });
});

describe("RemapActivity", () => {
  it("tracks the four remap phases", () => {
    const html = renderToStaticMarkup(<RemapActivity remap={remap()} />);
    expect(html).toContain("Wyliczam odstępy w oc_events");
    expect(html).toContain("stage 2 of 4");
  });

  it("says the visible numbers are the pre-remap ones", () => {
    const html = renderToStaticMarkup(<RemapActivity remap={remap()} />);
    expect(html).toContain("before the remap");
  });

  it("labels the row counts by vendor rather than by table", () => {
    const html = renderToStaticMarkup(
      <RemapActivity remap={remap({ rows: { oc_events: 12345, events: 7 } })} />
    );
    // The table name may still appear in the server's own message, so the
    // labelling is asserted on the ledger terms alone.
    const terms = [...html.matchAll(/<dt[^>]*>([^<]+)<\/dt>/g)].map((m) => m[1]);
    expect(terms).toEqual(["OpenCode", "Codex"]);
  });

  it("groups the thousands the way the rest of the UI does", () => {
    const html = renderToStaticMarkup(<RemapActivity remap={remap({ rows: { events: 12345 } })} />);
    // pl-PL separates groups with a non-breaking space, so the separator is
    // matched rather than spelled out.
    expect(html).toMatch(/12,345 events/);
  });

  it("shows per-table counts once a phase reports them", () => {
    const html = renderToStaticMarkup(
      <RemapActivity
        remap={remap({
          tables: {
            "projects:events": {
              phase: "projects",
              message: "Projekty w events: 900 / 1 000",
              assigned: 900,
              total: 1000,
            },
          },
        })}
      />
    );
    expect(html).toContain("Projekty w events");
    expect(html).toContain("900");
  });

  it("stays at stage 0 before the child emits its first event", () => {
    const html = renderToStaticMarkup(<RemapActivity remap={remap({ progress: null })} />);
    expect(html).toContain("stage 0 of 4");
  });

  it("redacts hostile paths and stack frames from every remap diagnostic surface", () => {
    const html = renderToStaticMarkup(
      <RemapActivity
        remap={remap({
          message: "Nie można otworzyć C:\\Users\\Alice Smith\\private\\atlas.db",
          why: "Reguły z \\\\internal-server\\Private Share\\rules.json",
          tables: {
            "projects:events": {
              phase: "projects",
              message: "Projekt z /home/alice/private/token-atlas/config.json",
            },
          },
          log_tail: [
            "Error: remap failed",
            "    at remap (/opt/token-atlas/src/remap.ts:12:4)",
            "safe failure code: remap-failed",
          ],
        })}
      />
    );
    expect(html).toContain("[ścieżka ukryta]");
    expect(html).toContain("remap-failed");
    for (const secret of ["Alice Smith", "internal-server", "Private Share", "/home/alice", "/opt/token-atlas", "at remap"]) {
      expect(html).not.toContain(secret);
    }
  });
});
