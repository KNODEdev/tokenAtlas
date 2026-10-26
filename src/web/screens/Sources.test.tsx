import { describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { VENDOR_IDS } from "../../sync/contracts";
import type { ApiAccount, AtlasSnapshotStatus, RosterProbe, SyncStatus } from "../lib/api";
import { probeMachineRows } from "../lib/probe";
import { sourceChecks, sourceProviderRows } from "../lib/source-providers";
import { chooseOption, dropdowns, installTestDom, invoke, type TestNode } from "../lib/test-dom-harness";
import type { SourceHealthRow } from "../../shared/source-health";
import {
  retrySyncScope,
  SnapshotCard,
  startSyncScope,
  SyncControlPanel,
} from "./Sources";

function snapshotStatus(over: Partial<AtlasSnapshotStatus> = {}): AtlasSnapshotStatus {
  return {
    running: false,
    mode: null,
    started_at: null,
    finished_at: null,
    result: null,
    error: null,
    newest_valid: null,
    discovery_error: null,
    ...over,
  };
}

describe("Sources sync controls", () => {
  it("gives every provider one row with one synchronize action and no second 'all sources' row", () => {
    const html = renderToStaticMarkup(<SyncControlPanel sync={null} onStart={() => {}} />);
    // GLM has no event source; its readings arrive with the limit readings row.
    expect((html.match(/>Synchronize<\/button>/g) ?? []).length).toBe(VENDOR_IDS.length);
    for (const scope of [...VENDOR_IDS, "glm"]) expect(html).toContain(`data-sync-scope="${scope}"`);
    expect(html).not.toContain('data-sync-scope="all"');
    expect(html).not.toContain("All sources");
    expect(html).toContain("Limit readings");
    expect(html).not.toContain("Odczyty");
    expect(html).toContain("Full update…");
    const scopes: Array<[string, string | undefined]> = [];
    startSyncScope((mode, vendor) => scopes.push([mode, vendor]), "grok", "full");
    startSyncScope((mode, vendor) => scopes.push([mode, vendor]), "all", "full");
    expect(scopes).toEqual([["full", "grok"], ["full", undefined]]);
  });

  it("starts a full update only after a second step that names the chosen scope", async () => {
    const dom = installTestDom();
    const root = createRoot(dom.host as unknown as Element);
    const starts: Array<[string, string | undefined]> = [];
    try {
      await act(async () => root.render(<SyncControlPanel sync={null} onStart={(mode, vendor) => starts.push([mode, vendor])} />));
      const all = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(all)];
      const button = (text: string) => all(dom.host).find((node) => node.tagName === "BUTTON" && node.textContent === text)!;
      await invoke(button("Full update…"), "onClick");
      await chooseOption(dropdowns(dom.host)[0]!, "grok");
      await invoke(button("Full update"), "onClick");
      expect(starts).toEqual([]);
      const confirm = all(dom.host).find((node) => node.attributes.role === "group")!;
      expect(confirm.attributes["aria-label"]).toBe("Confirm full update: Grok");
      expect(confirm.textContent).toContain("A full update rereads the entire range: Grok.");
      await invoke(button("Yes, start full update"), "onClick");
      expect(starts).toEqual([["full", "grok"]]);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("routes a failed full retry through scoped confirmation while incremental retries start directly", () => {
    const starts: Array<[string, string | undefined]> = [];
    const confirmations: Array<string | null> = [];
    const onStart = (mode: "incremental" | "full", vendor?: (typeof VENDOR_IDS)[number]) => starts.push([mode, vendor]);
    const onConfirm = (scope: (typeof VENDOR_IDS)[number] | "all" | null) => confirmations.push(scope);

    retrySyncScope(onStart, onConfirm, "full", "grok");
    expect(starts).toEqual([]);
    expect(confirmations).toEqual(["grok"]);

    retrySyncScope(onStart, onConfirm, "incremental", "grok");
    expect(starts).toEqual([["incremental", "grok"]]);
    expect(confirmations).toEqual(["grok"]);
  });

  it("presents partial success separately and retains the failed vendor's last-good revision", () => {
    const sync: SyncStatus = {
      running: false,
      trigger: "manual",
      mode: "incremental",
      started_at: "2026-09-01T10:00:00.000Z",
      finished_at: "2026-09-01T10:00:02.000Z",
      exit_code: 1,
      ok: false,
      phase: null,
      phase_index: 8,
      phase_count: 8,
      log_tail: [],
      run: {
        runId: "partial",
        trigger: "manual",
        scope: { kind: "all" },
        mode: "incremental",
        startedAt: "2026-09-01T10:00:00.000Z",
        finishedAt: "2026-09-01T10:00:02.000Z",
        status: "partial_success",
        beforeRevisions: { data: 4, config: 2, vendors: { codex: 2, claude: 1, opencode: 3, grok: 0, gemini: 0, gauges: 0 } },
        afterRevisions: { data: 5, config: 2, vendors: { codex: 3, claude: 1, opencode: 3, grok: 0, gemini: 0, gauges: 0 } },
        aggregateWorkRequested: true,
        vendors: [{
          vendor: "grok",
          status: "failure",
          processedInputs: 0,
          skippedInputs: 0,
          writtenRows: 0,
          dirtyRange: null,
          dataChanged: false,
          error: "fixture failure",
          diagnostics: {},
          startedAt: "2026-09-01T10:00:01.000Z",
          finishedAt: "2026-09-01T10:00:02.000Z",
        }],
        error: null,
      },
    };
    const html = renderToStaticMarkup(<SyncControlPanel sync={sync} onStart={() => {}} />);
    expect(html).toContain("partial success");
    expect(html).toContain("Some providers kept their previous valid state.");
    expect(html).toContain("Last run details");
    expect(html).toContain("Last good revision:");
    expect(html).toContain("r0");
    expect(html).toMatch(/data-sync-scope="grok"[\s\S]*?>error<[\s\S]*?>Retry<\/button>/);
  });

  it("marks only explicit pending vendor results active in a sparse all-vendor run", () => {
    const sync: SyncStatus = {
      running: true,
      trigger: "manual",
      mode: "incremental",
      started_at: "2026-09-01T10:00:00.000Z",
      finished_at: null,
      exit_code: null,
      ok: null,
      phase: null,
      phase_index: 1,
      phase_count: 5,
      log_tail: [],
      run: {
        runId: "sparse-running",
        trigger: "manual",
        scope: { kind: "all" },
        mode: "incremental",
        startedAt: "2026-09-01T10:00:00.000Z",
        finishedAt: null,
        status: "running",
        beforeRevisions: { data: 4, config: 2, vendors: { codex: 2, claude: 1, opencode: 3, grok: 0, gemini: 0, gauges: 0 } },
        afterRevisions: { data: 4, config: 2, vendors: { codex: 2, claude: 1, opencode: 3, grok: 0, gemini: 0, gauges: 0 } },
        aggregateWorkRequested: false,
        vendors: [{
          vendor: "codex",
          status: "pending",
          processedInputs: 0,
          skippedInputs: 0,
          writtenRows: 0,
          dirtyRange: null,
          dataChanged: false,
          error: null,
          diagnostics: {},
          startedAt: "2026-09-01T10:00:00.000Z",
          finishedAt: null,
        }],
        error: null,
      },
    };
    const html = renderToStaticMarkup(<SyncControlPanel sync={sync} onStart={() => {}} />);
    expect((html.match(/>running<\/span>/g) ?? []).length).toBe(2);
    expect((html.match(/>skipped<\/span>/g) ?? []).length).toBe(VENDOR_IDS.length - 1);
  });
});

describe("Atlas snapshot card", () => {
  it("renders newest-valid age, revisions, compatibility and the validation level", () => {
    const newest = {
      id: "snapshot-7",
      created_at: "2026-09-01T10:00:00.000Z",
      age_seconds: 125,
      revisions: { data: 7, config: 3, derived: 7 },
      vendor_revisions: { codex: 4, claude: 2, opencode: 1, grok: 0, gemini: 0, gauges: 0 },
      compatible: true,
      validation: "full" as const,
    };
    const fullHtml = renderToStaticMarkup(
      <SnapshotCard sync={null} snapshotStatus={snapshotStatus({ newest_valid: newest })} />
    );
    expect(fullHtml).toContain("latest valid 2 min ago");
    expect(fullHtml).toContain("r7/3/7");
    expect(fullHtml).toContain("Create now");
    expect(fullHtml).toContain("compatible · full manifest and database validation");
    expect(fullHtml).not.toContain("niezgłoszony przez API");

    const manifestHtml = renderToStaticMarkup(
      <SnapshotCard
        sync={null}
        snapshotStatus={snapshotStatus({ newest_valid: { ...newest, validation: "manifest-only" } })}
      />
    );
    expect(manifestHtml).toContain("manifest only - the database file was unavailable for full validation");
  });

  it("shows only sanitized discovery error fields", () => {
    const html = renderToStaticMarkup(
      <SnapshotCard
        sync={null}
        snapshotStatus={snapshotStatus({
          discovery_error: { code: "snapshot-pool-read-failed", stage: "discovery" },
        })}
      />
    );
    expect(html).toContain("Could not read the local Atlas snapshot pool");
    expect(html).toContain("stage: discovery");
    expect(html).toContain("code: snapshot-pool-read-failed");
    expect(html).not.toContain("niezgłoszony przez API");
  });

  it("renders reused feedback from the second manual publication result", () => {
    const html = renderToStaticMarkup(
      <SnapshotCard
        sync={null}
        snapshotStatus={snapshotStatus({
          mode: "manual",
          result: {
            status: "reused",
            reason: "identical-snapshot",
            snapshotId: "snapshot-stable",
            manifest: null,
            validation: null,
            leaseLostAfterCommit: false,
          },
        })}
      />
    );
    expect(html).toContain("The existing valid snapshot has the same revisions and was reused.");
  });
});

describe("data sources providers and checks", () => {
  const now = Date.now();
  const iso = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
  const probes: RosterProbe[] = [
    {
      provider: "codex",
      subject: "codex1",
      state: "fresh",
      fresh_minutes: 15,
      reading: { ts: iso(0.1), age_minutes: 6, machine: "EXAMPLE-MAIN" },
      machines: [
        { machine: "EXAMPLE-MAIN", last_ok_ts: iso(0.1), last_error_ts: null, last_error: null },
        {
          machine: "EXAMPLE-LAPTOP-A",
          last_ok_ts: null,
          last_error_ts: "2026-08-30T09:00:00.000Z",
          last_error: "auth.json missing",
        },
      ],
    },
    {
      provider: "glm",
      subject: "glm",
      state: "stale",
      fresh_minutes: 15,
      reading: { ts: iso(30), age_minutes: 1800, machine: "EXAMPLE-MAIN" },
      machines: [{ machine: "EXAMPLE-MAIN", last_ok_ts: iso(30), last_error_ts: null, last_error: null }],
    },
  ];
  const account = (over: Partial<ApiAccount>): ApiAccount => ({ id: "codex1", vendor: "codex", plan: null, login: null, machine: null, note: null,
    homes: [], ratelimit_rows: 0, event_rows: 0, windows: [], limit_ids: [], first_event_ts: null, last_event_ts: null, has_gauge: true, has_events: true, ...over });
  const source = (over: Partial<SourceHealthRow>): SourceHealthRow => ({ key: "k", subscription: "codex1", vendor: "codex", label: "codex1", machine: "EXAMPLE-MAIN",
    profile: null, archive: null, configured: true, historical: false, local: true, last_session: null, last_meter: null, last_attempt: null, error: null, status: "current", ...over });

  it("covers every provider, counts each account once and reads data age from sessions or readings", () => {
    const rows = sourceProviderRows({
      probes,
      sources: [source({ last_session: iso(2) }), source({ vendor: "gemini", subscription: "g1", last_session: iso(50) })],
      // One account listed per profile must not double its events; company names map to providers.
      accounts: [account({ event_rows: 100 }), account({ event_rows: 100, machine: "LAPTOP" }), account({ id: "claude-a", vendor: "anthropic", event_rows: 40, last_event_ts: iso(5) })],
    });
    expect(rows.map((row) => row.id)).toEqual(["codex", "claude", "opencode", "grok", "gemini", "glm", "gauges"]);
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId.codex).toMatchObject({ sync: "codex", events: 100, latest: iso(2) });
    expect(byId.claude).toMatchObject({ events: 40, latest: iso(5) });
    expect(byId.gemini!.latest).toBe(iso(50));
    expect(byId.opencode).toMatchObject({ events: null, latest: null });
    expect(byId.glm).toMatchObject({ sync: null, latest: iso(30) });
    expect(byId.gauges).toMatchObject({ sync: "gauges", latest: iso(0.1) });
    // The exact table sizes from /api/health win over the account sums.
    expect(sourceProviderRows({ probes: [], sources: [], accounts: [], tables: { events: 7 } })[0]!.events).toBe(7);
  });

  it("turns probe failures, missing counters, unpriced models and identity into one line each", () => {
    expect(probeMachineRows(probes)[1]!.failing).toBe(true);
    const checks = sourceChecks({
      probes,
      accounts: [account({ id: "claude-c", vendor: "claude", has_gauge: false }), account({ id: "claude-c", vendor: "claude", has_gauge: false, machine: "B" })],
      unpricedTokens: 10_840_000_000,
      unpricedModels: 14,
      identity: [],
      watch: null,
    });
    const byKey = Object.fromEntries(checks.map((check) => [check.key, check]));
    const probe = checks.find((check) => check.key.startsWith("probe:"))!;
    expect(probe).toMatchObject({ tone: "warn", link: "profiles", title: "Limit reading codex1" });
    expect(probe.detail).toContain("EXAMPLE-LAPTOP-A");
    expect(probe.detail).toContain("auth.json missing");
    expect(byKey.counters).toMatchObject({ tone: "warn", link: "periods", title: "1 subscription without a counter" });
    expect(byKey.counters!.items).toEqual(["claude-c"]);
    expect(byKey.prices).toMatchObject({ tone: "info", link: "rates", title: "14 models without a price" });
    expect(byKey.prices!.detail).toContain("10.84B");
    expect(byKey.identity).toMatchObject({ tone: "ok", detail: "no warnings" });
    expect(checks.some((check) => check.key === "watch")).toBe(false);
  });

  it("reports healthy checks as passed instead of hiding them", () => {
    const checks = sourceChecks({ probes: [probes[1]!], accounts: [account({})], unpricedTokens: 0, unpricedModels: 0, identity: [],
      watch: { active: true, running: false, followUpPending: false, reconciliationMs: 0, debounceMs: 0, watchedRoots: ["a", "b"], missingRoots: [], errors: [], lastSignalAt: null, lastReconciledAt: null } });
    expect(checks.map((check) => check.tone)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(checks.find((check) => check.key === "watch")!.detail).toBe("2 folders watched");
  });

  it("keeps a check to one line and folds the list that grows with the data", () => {
    const missing = Array.from({ length: 32 }, (_, i) => `C:/Users/u${i}/.codex/sessions`);
    const [watch] = sourceChecks({ probes: [], accounts: [], unpricedTokens: 0, unpricedModels: 0, identity: [],
      watch: { active: true, running: false, followUpPending: false, reconciliationMs: 0, debounceMs: 0, watchedRoots: [], missingRoots: missing, errors: ["EPERM"], lastSignalAt: null, lastReconciledAt: null } })
      .filter((check) => check.key === "watch");
    expect(watch).toMatchObject({ tone: "warn", detail: "32 folders missing · 1 error" });
    expect(watch!.items).toHaveLength(33);
    expect(watch!.detail).not.toContain("C:");
  });
});
