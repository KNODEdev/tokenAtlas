import { splitProbeReaderFixtureConfig } from "./probe-reader.fixture";
import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { fileURLToPath } from "node:url";
import { applyDrizzleMigrations } from "../db/migrate";
import { MACHINE } from "../config/paths";
import { buildEraIndex } from "./eras";
import { createFetchHandler, handleAccounts, handleRoster, runCodexProbePoll, type AppContext } from "./api";
import { codexIdentityAliases, rememberedCodexAccounts, resolveCodexDiscovery } from "./codex-discovery";
import { prepareProbeReaderFixture, probeReaderFixtureSource } from "./probe-reader.fixture";

const home = "C:/Users/one/.codex";
const declarations = [
  { id: "codex2", vendor: "codex", home: "C:/archive/one", source_home: home, account: "old@example.com", until: "2026-05-01" },
  { id: "codex3", vendor: "codex", home: "C:/archive/one", source_home: home, account: "new@example.com", from: "2026-05-01" },
];
function context(): AppContext {
  const sqlite = new Database(":memory:");
  applyDrizzleMigrations(drizzle(sqlite), fileURLToPath(new URL("../../drizzle", import.meta.url)));
  prepareProbeReaderFixture(sqlite, [probeReaderFixtureSource("glm", "glm")]);
  return { sqlite, accounts: splitProbeReaderFixtureConfig(declarations), homeToSubId: new Map(), subIdToHomes: new Map(),
    eras: buildEraIndex(declarations), eraErrors: [], claudeGauge: {}, grokGauge: {}, rateCards: {},
    plans: {}, cycles: {}, plansCatalog: {provider_groups: []}, rootDir: "", homeConflict: null } as unknown as AppContext;
}
const profile = { home, login: "one", machine: MACHINE, error: null,
  identity: { key: "account:old", account_id: "old", email: "old@example.com" } };

test("live identity selects the actual account and revives its card without rewriting historical declarations", async () => {
  const ctx = context();
  try {
    ctx.scanCodexProfiles = () => [profile];
    const targets: string[] = [];
    await runCodexProbePoll(ctx, undefined, async (_db, sources) => { targets.push(...sources.map(s => s.account)); });
    expect(targets).toEqual(["codex2"]);
    expect(ctx.eras.resolve("codex", home, "2026-09-09T12:00:00Z")).toBe("codex3");
    const roster = await (await handleRoster(ctx, new URL("http://127.0.0.1/api/roster"))).json() as {accounts: unknown[]};
    expect(roster.accounts).toContainEqual(expect.objectContaining({id:"codex2",active:true,vendor_account:"old@example.com"}));
    ctx.scanCodexProfiles = () => [{ ...profile, identity: null, error: "access denied" }];
    targets.length = 0;
    await runCodexProbePoll(ctx, undefined, async (_db, sources) => { targets.push(...sources.map(s => s.account)); });
    expect(targets).toEqual([]);
  } finally { ctx.sqlite.close(); }
});
test("a detected account can be selected before its historical sessions are assigned", async () => {
  const ctx = context();
  try {
    ctx.codexDiscovery = resolveCodexDiscovery([profile], [], [], MACHINE);
    const id = ctx.codexDiscovery.accounts[0]!.id;
    const response = await createFetchHandler(ctx)(new Request(`http://127.0.0.1/api/usage-series?account=${id}`));
    expect(response.status).toBe(200);
    expect((await response.json() as {cycles:unknown[]}).cycles).toEqual([]);
    expect(ctx.accounts).toEqual(splitProbeReaderFixtureConfig(declarations));
  } finally { ctx.sqlite.close(); }
});
test("recorded identity restores the discovered account after restart", () => {
  const ctx = context();
  try {
    const proof = { ...profile.identity, subscription: "codex2", home, login: "one", machine: MACHINE };
    const insert = ctx.sqlite.query("INSERT INTO probe_windows (provider,subject,ts,kind,reported_percent_side,extra) VALUES ('codex','codex2',?,'primary','used',?)");
    insert.run("2026-09-09T12:00:00Z", JSON.stringify({home,codex_account:JSON.stringify(proof)}));
    insert.run("2026-09-09T13:00:00Z", JSON.stringify({home}));
    expect(rememberedCodexAccounts(ctx.sqlite)).toEqual([proof]);
  } finally { ctx.sqlite.close(); }
});

test("accounts on the same machine profile remain selectable independently", async () => {
  const ctx = context();
  try {
    const second = { ...profile, home: home + "-other", identity: { key: "account:fresh", account_id: "fresh", email: "fresh@example.com" } };
    ctx.codexDiscovery = resolveCodexDiscovery([profile, second], [], [], MACHINE);
    const ids = ctx.codexDiscovery.accounts.map(a => a.id);
    expect(ids).toHaveLength(2);
    const res = await handleAccounts(ctx).json() as { subscriptions: { id: string; vendor: string }[] };
    for (const id of ids) expect(res.subscriptions).toContainEqual(expect.objectContaining({ id, vendor: "codex" }));
  } finally { ctx.sqlite.close(); }
});

test("a login remembered under a declared and a minted id resolves to the declared one; a billing variant is no login", () => {
  const evidence = (subscription: string) => ({ key: "account:a1", account_id: "a1", email: "hello@example.com", subscription,
    home: "C:/Users/one/.codex-3", login: "one", machine: "OTHER" });
  const declared = [{ id: "codex3", vendor: "codex", account: "hello@example.com" },
    { id: "codex1::business", vendor: "codex", account: "hello@example.com" }];
  const live = { ...profile, home: "C:/Users/one/.codex-3", identity: { key: "account:a1", account_id: "a1", email: "hello@example.com" } };
  for (const remembered of [[evidence("codex3"), evidence("chatgpt-minted")], [evidence("chatgpt-minted"), evidence("codex3")]])
    expect(resolveCodexDiscovery([live], declared, remembered, MACHINE).accounts.map(a => a.id)).toEqual(["codex3"]);
  expect(resolveCodexDiscovery([live], declared, [], MACHINE).accounts.map(a => a.id)).toEqual(["codex3"]);
  expect([...codexIdentityAliases([evidence("chatgpt-minted"), evidence("codex3")], declared)]).toEqual([["chatgpt-minted", "codex3"]]);
  // Two declarations on one login: the minted id stays its own.
  expect(codexIdentityAliases([evidence("chatgpt-minted"), evidence("codex3"), evidence("codex4")],
    [...declared, { id: "codex4", vendor: "codex", account: "a1" }]).size).toBe(0);
});
