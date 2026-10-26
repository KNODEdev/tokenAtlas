import { splitProbeReaderFixtureConfig } from "./probe-reader.fixture";
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fs from "fs";
import os from "os";
import path from "path";
import { applyDrizzleMigrations } from "../db/migrate";
import { ARCHIVE_LOGICAL_ROOT, LOGIN } from "../config/paths";
import { readCodexIdentity } from "../providers/adapters/codex";
import { observedIdentities } from "./account-period-feed";
import { recordObservedReading, type ObservedReading } from "./observed-reading-fixture";
import { buildIdentityReport, observedVendorAccounts, type AppContext, type IdentityWarning } from "./api";
import { indexSubscriptionHomes } from "./capacity-equivalents";
import { buildEraIndex } from "./eras";
import { saveSetup } from "./setup";

const MIGRATIONS = path.resolve(import.meta.dir, "../../drizzle");
const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  }
});

function migratedDb(): Database {
  const sqlite = new Database(":memory:");
  applyDrizzleMigrations(drizzle(sqlite), MIGRATIONS);
  return sqlite;
}

function jwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
  return `header.${body}.signature`;
}

function codexHome(tokens: Record<string, unknown> | null): string {
  const home = tempDir("ta-codex-");
  if (tokens) fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ tokens }), "utf-8");
  return home;
}

function stubCtx(sqlite: Database, subscriptions: AppContext["accounts"]["subscriptions"]): AppContext {
  return {
    sqlite,
    accounts: splitProbeReaderFixtureConfig(subscriptions),
    homeToSubId: indexSubscriptionHomes(subscriptions ?? []),
    eras: buildEraIndex(subscriptions ?? []),
    eraErrors: [],
  } as unknown as AppContext;
}

function read(sqlite: Database, ctx: AppContext, reading: ObservedReading): string {
  return recordObservedReading(sqlite, ctx.accounts.subscriptions ?? [], reading);
}

describe("identity readers", () => {
  it("takes the codex e-mail out of the id_token payload without verifying it", () => {
    const home = codexHome({ id_token: jwt({ email: "codex-user@example.com", account_id: "acc_1" }) });
    expect(readCodexIdentity(home).identity).toEqual({
      identity_kind: "email",
      identity: "codex-user@example.com",
      raw_source: path.join(home, "auth.json"),
    });
  });

  it("falls back to the codex account_id when the token carries no e-mail", () => {
    const home = codexHome({ id_token: jwt({ account_id: "acc_7" }) });
    const read = readCodexIdentity(home);
    expect(read.identity?.identity_kind).toBe("profile");
    expect(read.identity?.identity).toBe("acc_7");
  });

  it("tolerates a missing or unparsable codex auth.json", () => {
    const absent = readCodexIdentity(codexHome(null));
    expect(absent.identity).toBeNull();
    expect(absent.error).toContain("No ChatGPT login");
    const broken = codexHome({ id_token: "not-a-jwt" });
    expect(readCodexIdentity(broken).identity).toBeNull();
  });
});

describe("observedIdentities", () => {
  it("names the account behind each running observed period from its last reading", () => {
    const sqlite = migratedDb();
    const ctx = stubCtx(sqlite, []);
    const source = read(sqlite, ctx, { account: "codex2", email: "one@example.com", ts: "2026-09-10T10:00:00.000Z" });
    read(sqlite, ctx, { account: "codex2", email: "one@example.com", ts: "2026-09-10T10:10:00.000Z" });
    expect(observedIdentities(sqlite, { declarations: [], archiveRoot: ARCHIVE_LOGICAL_ROOT, defaultLogin: LOGIN })).toEqual([{
      provider: "codex", source, account: "codex2", machine: "PC", home: "C:/Users/x/.codex",
      identity_kind: "email", identity: "one@example.com", since: "2026-09-10T10:00:00.000Z", ts: "2026-09-10T10:10:00.000Z",
    }]);
  });

  it("follows a switch to another account and falls back to the profile key without an e-mail", () => {
    const sqlite = migratedDb();
    const ctx = stubCtx(sqlite, []);
    read(sqlite, ctx, { account: "codex2", email: "one@example.com", ts: "2026-09-10T10:00:00.000Z" });
    read(sqlite, ctx, { account: "codex3", email: null, ts: "2026-09-11T10:00:00.000Z" });
    const [current, ...rest] = observedIdentities(sqlite, { declarations: [], archiveRoot: ARCHIVE_LOGICAL_ROOT, defaultLogin: LOGIN });
    expect(rest).toEqual([]);
    expect(current).toMatchObject({ account: "codex3", identity_kind: "profile", identity: "account:codex3", since: "2026-09-11T10:00:00.000Z" });
  });

  it("writes nothing for readings: identity is read, never logged", () => {
    const sqlite = migratedDb();
    const ctx = stubCtx(sqlite, []);
    read(sqlite, ctx, { account: "codex2", email: "one@example.com", ts: "2026-09-10T10:00:00.000Z" });
    const before = sqlite.query("SELECT total_changes() AS n").get();
    buildIdentityReport(ctx);
    expect(sqlite.query("SELECT total_changes() AS n").get()).toEqual(before);
  });
});

describe("observedVendorAccounts", () => {
  it("gives the newest identity per account, across its sources", () => {
    const sqlite = migratedDb();
    const ctx = stubCtx(sqlite, []);
    read(sqlite, ctx, { account: "codex2", email: "old@example.com", ts: "2026-08-01T10:00:00.000Z" });
    read(sqlite, ctx, { account: "codex2", email: "new@example.com", ts: "2026-08-29T10:00:00.000Z", machine: "LAPTOP" });
    expect(observedVendorAccounts(ctx).get("codex2")).toBe("new@example.com");
  });

  it("is empty when nothing has been read", () => {
    expect(observedVendorAccounts(stubCtx(migratedDb(), []))).toEqual(new Map());
  });
});

describe("buildIdentityReport", () => {
  const home = "C:/Users/x/.codex";
  const declared = (account?: string) => [{ id: "codex2", vendor: "codex", home: "D:/archive/codex/x", source_home: home, ...(account ? { account } : {}) }];

  it("flags a source logged in as somebody other than the declared account", () => {
    const sqlite = migratedDb();
    const ctx = stubCtx(sqlite, declared("mine@example.com"));
    read(sqlite, ctx, { account: "codex2", email: "other@example.com", ts: "2026-08-30T10:00:00.000Z" });
    const report = buildIdentityReport(ctx);
    expect(report.sources).toHaveLength(1);
    expect(report.sources[0]).toMatchObject({
      vendor: "codex",
      source: home,
      subscription_id: "codex2",
      identity: "other@example.com",
      declared: "mine@example.com",
      machine: "PC",
    });
    // The mismatch is the only warning: the era-boundary suggestion is retired (stage 4, W4).
    expect(report.warnings.map((w) => w.kind)).toEqual(["account-mismatch"]);
    const warning = report.warnings.find((w) => w.kind === "account-mismatch") as IdentityWarning;
    expect(Object.keys(warning).sort()).toEqual(
      ["declared", "hint", "kind", "observed", "source", "subscription_id", "ts", "vendor"]
    );
    expect(warning.observed).toBe("other@example.com");
    expect(warning.declared).toBe("mine@example.com");
    expect(warning.ts).toBe("2026-08-30T10:00:00.000Z");
    expect(JSON.parse(JSON.stringify(warning))).toEqual(warning);
  });

  it("stays silent when the declaration matches, ignoring case and padding", () => {
    const sqlite = migratedDb();
    const ctx = stubCtx(sqlite, declared("mine@example.com"));
    read(sqlite, ctx, { account: "codex2", email: "Mine@Example.com ", ts: "2026-08-30T10:00:00.000Z" });
    expect(buildIdentityReport(ctx).warnings).toEqual([]);
  });

  it("treats an undeclared account as legal", () => {
    const sqlite = migratedDb();
    const ctx = stubCtx(sqlite, declared());
    read(sqlite, ctx, { account: "codex2", email: "other@example.com", ts: "2026-08-30T10:00:00.000Z" });
    const report = buildIdentityReport(ctx);
    expect(report.warnings).toEqual([]);
    expect(report.sources[0]).toMatchObject({ subscription_id: "codex2", declared: null });
  });

  it("resolves other vendors by the account their readings name", () => {
    const sqlite = migratedDb();
    const ctx = stubCtx(sqlite, [{ id: "claude1", vendor: "claude", home: "D:/archive/claude/x", account: "declared@example.com" }]);
    read(sqlite, ctx, { provider: "claude", account: "claude1", email: "seen@example.com", ts: "2026-08-30T11:00:00.000Z", home: `C:/Users/${LOGIN}/.claude`, login: LOGIN });
    const report = buildIdentityReport(ctx);
    expect(report.warnings[0]).toMatchObject({ vendor: "claude", subscription_id: "claude1", kind: "account-mismatch" });
  });

  it("reports an account no subscription declares", () => {
    const sqlite = migratedDb();
    const ctx = stubCtx(sqlite, []);
    read(sqlite, ctx, { account: "codex9", email: "other@example.com", ts: "2026-08-30T10:00:00.000Z" });
    const report = buildIdentityReport(ctx);
    expect(report.sources[0]).toMatchObject({ subscription_id: null, declared: null });
    expect(report.warnings).toEqual([]);
  });
});

describe("accounts.json metadata", () => {
  it("preserves account metadata through a source-only wizard re-save", () => {
    const configRoot = tempDir("ta-config-");
    // A TOKENATLAS_CONFIG inherited from the developer's shell would make the
    // wizard refuse to write anywhere else.
    const inheritedConfig = process.env.TOKENATLAS_CONFIG;
    delete process.env.TOKENATLAS_CONFIG;
    const accountsFile = path.join(configRoot, "accounts.json");
    fs.writeFileSync(
      accountsFile,
      JSON.stringify({
        version: 2,
        subscriptions: [
          { id: "codex1", vendor: "codex", note: "stara", account: "mine@example.com" },
          { id: "codex2", vendor: "codex" },
        ],
        sources: [
          { vendor: "codex", home: "D:/archive/codex/a" },
          { vendor: "codex", home: "D:/archive/codex/b" },
        ],
      }),
      "utf-8"
    );
    try {
      saveSetup(
        {
          config: configRoot,
          sources: [
            { vendor: "codex", home: "D:/archive/codex/a" },
            { vendor: "codex", home: "D:/archive/codex/b" },
          ],
        },
        { envFile: path.join(configRoot, ".env") }
      );
    } finally {
      if (inheritedConfig !== undefined) process.env.TOKENATLAS_CONFIG = inheritedConfig;
    }
    const saved = JSON.parse(fs.readFileSync(accountsFile, "utf-8")) as {
      subscriptions: Array<{ id: string; account?: string; note?: string }>;
    };
    expect(saved.subscriptions[0]).toMatchObject({ id: "codex1", account: "mine@example.com", note: "stara" });
    expect(saved.subscriptions[1]?.account).toBeUndefined();
    expect("account" in (saved.subscriptions[1] ?? {})).toBe(false);
  });
});
