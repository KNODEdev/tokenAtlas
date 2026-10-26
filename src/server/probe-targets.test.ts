import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LOGIN, MACHINE } from "../config/paths";
import { probeTargets, type AppContext } from "./api";
import { buildEraIndex } from "./eras";
import { discoverCodexHome } from "../providers/adapters/codex";
import { readCodexAccountIdentity } from "../providers/codex-identity";
import { resolveCodexDiscovery } from "./codex-discovery";
import { splitProbeReaderFixtureConfig } from "./probe-reader.fixture";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { archiveFolderOf } from "./event-source";
import { ACCOUNT_PERIODS, replaceDeclaredPeriods } from "../db/period-store";

const tempDirectories: string[] = [];

afterAll(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function sourceDirectory(name: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `tokenatlas-probe-${name}-`));
  tempDirectories.push(directory);
  return directory;
}

type Subscriptions = NonNullable<AppContext["accounts"]["subscriptions"]>;

type FixtureRow = Subscriptions[number] & { home: string; machine?: string; login?: string; source_home?: string; from?: string; until?: string };
function stubCtx(subscriptions: FixtureRow[]): AppContext {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE account_periods (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, source TEXT NOT NULL,
    from_ts TEXT NOT NULL, until_ts TEXT, account TEXT NOT NULL, origin TEXT NOT NULL, first_seen TEXT,
    last_seen TEXT, readings INTEGER NOT NULL DEFAULT 0, evidence TEXT NOT NULL)`);
  replaceDeclaredPeriods(sqlite, ACCOUNT_PERIODS, subscriptions.map(row => ({ provider: "codex",
    subject: archiveFolderOf(row.home, ARCHIVE_LOGICAL_ROOT)!.key, value: row.id,
    from: row.from ?? "2000-01-01", until: row.until ?? null, origin: "declared" as const,
    firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" })));
  return {
    sqlite,
    accounts: splitProbeReaderFixtureConfig(subscriptions),
    // probeTargets never reads the static map; building it would reject the consecutive-era fixture.
    homeToSubId: new Map<string, string>(),
    eras: buildEraIndex(subscriptions),
    eraErrors: [],
  } as unknown as AppContext;
}

describe("probeTargets", () => {
  it("discovers a local profile by account identity without changing declarations", () => {
    const mine = sourceDirectory("discovery");
    fs.writeFileSync(path.join(mine, "auth.json"), JSON.stringify({
      tokens: { id_token: `header.${Buffer.from(JSON.stringify({ email: "shared@example.com" })).toString("base64url")}.signature` },
    }));
    const discover = (account: string | undefined) => discoverCodexHome(account, [mine]);
    const subscriptions: FixtureRow[] = [
      { id: "codex1", vendor: "codex", machine: "OTHER-PC", home: `${ARCHIVE_LOGICAL_ROOT}/codex/there`, source_home: mine, account: "shared@example.com" },
      { id: "codex1", vendor: "codex", machine: MACHINE, home: `${ARCHIVE_LOGICAL_ROOT}/codex/here`, account: "shared@example.com" },
      { id: "wrong", vendor: "codex", machine: MACHINE, home: `${ARCHIVE_LOGICAL_ROOT}/codex/wrong`, account: "other@example.com" },
      { id: "unknown", vendor: "codex", machine: MACHINE, home: `${ARCHIVE_LOGICAL_ROOT}/codex/unknown` },
      { id: "remote", vendor: "codex", machine: "OTHER-PC", home: `${ARCHIVE_LOGICAL_ROOT}/codex/remote` },
      { id: "closed", vendor: "codex", machine: MACHINE, home: `${ARCHIVE_LOGICAL_ROOT}/codex/closed`, until: "2026-09-01" },
    ];
    const ctx = stubCtx(subscriptions);
    const refresh = () => { ctx.codexDiscovery = resolveCodexDiscovery([
      { home: mine, machine: MACHINE, login: LOGIN, ...readCodexAccountIdentity(mine) },
    ], ctx.accounts.subscriptions, [], MACHINE); };
    refresh();
    expect(probeTargets(ctx, "2026-09-02T12:00:00Z", discover)).toMatchObject([{ account: "codex1", home: mine }]);
    expect(subscriptions[1]!.source_home).toBeUndefined();
    // A logout or account switch must stop discovery at the next poll.
    fs.writeFileSync(path.join(mine, "auth.json"), "{}");
    refresh();
    expect(probeTargets(ctx, "2026-09-02T12:00:00Z", discover)).toEqual([]);
    fs.writeFileSync(path.join(mine, "auth.json"), "invalid JSON");
    expect(discover("shared@example.com")).toBeNull();
    ctx.sqlite.close();
  });

  it("keeps an explicit source authoritative when discovery is available", () => {
    const mine = sourceDirectory("explicit");
    const ctx = stubCtx([
      { id: "codex1", vendor: "codex", machine: MACHINE, home: `${ARCHIVE_LOGICAL_ROOT}/codex/here`, source_home: mine, account: "a@example.com" },
    ]);
    expect(probeTargets(ctx, "2026-09-02T12:00:00Z", () => { throw new Error("unexpected discovery"); }))
      .toEqual([{ account: "codex1", home: mine }]);
    ctx.sqlite.close();
  });

  it("takes only sources declared for this machine that exist here", () => {
    const mine = sourceDirectory("mine");
    const shared = sourceDirectory("shared");
    const other = sourceDirectory("other-login");
    const ctx = stubCtx([
      { id: "codex1", vendor: "codex", machine: MACHINE, home: `${ARCHIVE_LOGICAL_ROOT}/codex/here`, source_home: mine },
      { id: "codex3", vendor: "codex", machine: "OTHER-PC", login: "someone-else", home: `${ARCHIVE_LOGICAL_ROOT}/codex/there-2`, source_home: path.join(shared, "missing") },
      { id: "codex4", vendor: "codex", machine: MACHINE, home: `${ARCHIVE_LOGICAL_ROOT}/codex/anywhere`, source_home: shared },
      { id: "codex5", vendor: "codex", machine: MACHINE, home: `${ARCHIVE_LOGICAL_ROOT}/codex/nowhere`, source_home: path.join(mine, "does-not-exist") },
      // Another machine, another login, but the directory exists here: still not ours.
      { id: "codex6", vendor: "codex", machine: "OTHER-PC", login: "someone-else", home: `${ARCHIVE_LOGICAL_ROOT}/codex/x`, source_home: other },
      // Another machine, same login: still not evidence of the same vendor account.
      { id: "codex7", vendor: "codex", machine: "OTHER-PC", login: LOGIN, home: `${ARCHIVE_LOGICAL_ROOT}/codex/y`, source_home: sourceDirectory("same-login") },
    ]);
    expect(probeTargets(ctx, "2026-09-02T12:00:00.000Z").map((t) => t.account)).toEqual(["codex1", "codex4"]);
  });

  it("probes one source once even when several entries name it", () => {
    const mine = sourceDirectory("dup");
    const ctx = stubCtx([
      { id: "codex1", vendor: "codex", machine: MACHINE, home: `${ARCHIVE_LOGICAL_ROOT}/codex/a`, source_home: mine },
      { id: "codex1", vendor: "codex", machine: MACHINE, home: `${ARCHIVE_LOGICAL_ROOT}/codex/b`, source_home: mine.toUpperCase() },
    ]);
    expect(probeTargets(ctx, "2026-09-02T12:00:00.000Z")).toHaveLength(1);
  });

  it("matches the machine name case-insensitively and skips closed eras", () => {
    const mine = sourceDirectory("era");
    const ctx = stubCtx([
      { id: "codex2", vendor: "codex", machine: MACHINE.toLowerCase(), home: `${ARCHIVE_LOGICAL_ROOT}/codex/old`, source_home: mine, until: "2026-08-22" },
      { id: "codex3", vendor: "codex", machine: MACHINE.toLowerCase(), home: `${ARCHIVE_LOGICAL_ROOT}/codex/new`, source_home: mine, from: "2026-08-22" },
    ]);
    expect(probeTargets(ctx, "2026-09-02T12:00:00.000Z").map((t) => t.account)).toEqual(["codex3"]);
  });
});
