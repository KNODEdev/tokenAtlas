import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../db/schema";
import { applyDrizzleMigrations } from "../db/migrate";
import { replaceClaudeFileEvents, upsertClaudeEvents } from "./claude";
import { parseClaudeFixture } from "./native-test-support";
import { claudeAccountKey, claudeIdentitySubscription } from "./claude-identity";
import { rememberedVendorAccounts, resolveVendorDiscovery } from "../server/vendor-discovery";

const account = "6deed05f-c0a9-41d1-8e7f-fd5baaa36db2", org = "bd47f8bf-640e-4156-ad4a-4d6650376a59";
const other = "3c56ad18-8472-452a-b5a2-4437e25a7e4a", session = "4b486c27-4f4f-486a-a380-ba9072412f01";
const key = claudeAccountKey(account, org)!, id = claudeIdentitySubscription(key);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function directory() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-identity-")); dirs.push(dir); return dir; }
function write(file: string, rows: unknown[]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join("\n")); return file; }
const assistant = (sid = session) => ({ type: "assistant", sessionId: sid, timestamp: "2026-08-12T10:00:00Z", message: { id: "call", model: "claude-sonnet", usage: { input_tokens: 12, output_tokens: 5 } } });
const owner = (a = account, sid = session) => ({ type: "bridge-session", sessionId: sid, ownerAccountUuid: a, ownerOrganizationUuid: org });
function database() { const sqlite = new Database(":memory:"); const db = drizzle(sqlite, { schema }); applyDrizzleMigrations(db, path.resolve(import.meta.dir, "../../drizzle")); return { sqlite, db }; }

test("authenticated session owner wins regardless of marker position; none and conversation text are not ownership", async () => {
  const file = path.join(directory(), "session.jsonl");
  const [event] = await parseClaudeFixture("live", write(file, [assistant(), owner(), owner("none")]));
  expect(event).toMatchObject({ account_key: key, subscription_id: id, subscription_conflict: 0 });
  const [unmarked] = await parseClaudeFixture("live", write(file, [assistant(), { type: "user", content: owner() }, owner(account, "another-session")]));
  // Without a session identity nothing names the account; the periods resolve it at read time.
  expect(unmarked).toMatchObject({ account_key: null, subscription_id: null });
  expect(claudeAccountKey("none", "none")).toBeNull();
  const [conflict] = await parseClaudeFixture("live", write(file, [assistant(), owner(), owner(other)]));
  expect(conflict).toMatchObject({ subscription_id: null, subscription_conflict: 1 });
});

test("subagents inherit only the matching parent inside their own source", async () => {
  const root = directory(), parent = path.join(root, "PC-A", "project", session);
  write(parent + ".jsonl", [owner()]);
  const child = write(path.join(parent, "subagents", "agent-a.jsonl"), [assistant()]);
  expect((await parseClaudeFixture("live", child))[0]?.account_key).toBe(key);
  const otherPc = write(path.join(root, "PC-B", "project", session, "subagents", "agent-a.jsonl"), [assistant()]);
  expect((await parseClaudeFixture("live", otherPc))[0]?.account_key).toBeNull();
  write(parent + ".jsonl", [owner(other)]);
  expect((await parseClaudeFixture("live", child))[0]?.account_key).toBe(claudeAccountKey(other, org));
});

test("complete SDK copies retain the transcript timestamp and undated-only copies are excluded", async () => {
  const file = path.join(directory(), "session.jsonl");
  const dated = assistant();
  const sdk = { type: "assistant", message: { ...dated.message, stop_reason: "end_turn", usage: { input_tokens: 12, output_tokens: 50 } } };
  for (const copies of [[dated, sdk], [sdk, dated]]) {
    const events = await parseClaudeFixture("desktop", write(file, [...copies, owner()]));
    // Stored as the canonical instant, whatever the transcript's spelling.
    expect(events[0]).toMatchObject({ ts: new Date(dated.timestamp).toISOString(), session_id: session, out_total: 50, account_key: key });
  }
  expect(await parseClaudeFixture("desktop", write(file, [sdk]))).toEqual([]);
});

test("Desktop audit requires exact init session, local prefix and account/org path", async () => {
  const root = directory(), prefix = "014a073f";
  const file = write(path.join(root, `${prefix}-${session}.jsonl`), [assistant()]);
  const audit = path.join(root, `${prefix}-audit.jsonl`);
  const init = { type: "system", subtype: "init", session_id: session, cwd: `C:\\Users\\x\\AppData\\Roaming\\Claude\\local-agent-mode-sessions\\${account}\\${org}\\local_${prefix}-60cb-4375-b668-54dd38949455\\outputs` };
  write(audit, [init]);
  expect((await parseClaudeFixture("desktop", file))[0]?.account_key).toBe(key);
  const { timestamp, ...auditAssistant } = assistant();
  write(audit, [init, { ...auditAssistant, _audit_timestamp: timestamp }]);
  expect((await parseClaudeFixture("desktop", audit))[0]).toMatchObject({ account_key: key, ts: new Date(timestamp).toISOString() });
  for (const invalid of [{ ...init, session_id: "wrong" }, { ...init, cwd: "/sessions/unknown" }, { ...init, subtype: "user" }]) {
    write(audit, [invalid]); expect((await parseClaudeFixture("desktop", file))[0]?.account_key).toBeNull();
  }
});

test("duplicate import and forced file replacement preserve proven identity and conflicting keys stay excluded", async () => {
  const { sqlite, db } = database();
  try {
    const file = write(path.join(directory(), "session.jsonl"), [assistant(), owner()]);
    const event = (await parseClaudeFixture("live", file))[0]!;
    const generic = { ...event, account_key: null, subscription_id: "generic" };
    for (const order of [[generic, event], [event, generic]]) {
      sqlite.run("DELETE FROM claude_events");
      for (const item of order) upsertClaudeEvents(db, [item]);
      replaceClaudeFileEvents(db, sqlite, "live", file, [generic]);
      expect(sqlite.query("SELECT account_key,subscription_id,subscription_conflict FROM claude_events").get()).toEqual({ account_key: key, subscription_id: id, subscription_conflict: 0 });
    }
    upsertClaudeEvents(db, [{ ...event, account_key: claudeAccountKey(other, org), subscription_id: "other" }]);
    replaceClaudeFileEvents(db, sqlite, "live", file, [event]);
    expect(sqlite.query("SELECT subscription_id,subscription_conflict FROM claude_events").get()).toEqual({ subscription_id: null, subscription_conflict: 1 });
  } finally { sqlite.close(); }
});

test("a fresh installation recovers the same account from relocated archives and joins its new PC login", async () => {
  const { sqlite, db } = database();
  try {
    const file = write(path.join(directory(), "new-drive", "old-PC", "session.jsonl"), [assistant(), owner()]);
    upsertClaudeEvents(db, await parseClaudeFixture("live", file));
    const remembered = rememberedVendorAccounts(sqlite);
    expect(remembered).toHaveLength(1);
    expect(remembered[0]?.id).toBe(id);
    // Read on the main thread before every live reading: it must stay on its partial index.
    const plan = sqlite.query(`EXPLAIN QUERY PLAN SELECT DISTINCT account_key FROM claude_events
      WHERE account_key IS NOT NULL AND COALESCE(subscription_conflict,0)=0`).all() as Array<{ detail: string }>;
    expect(plan.map(row => row.detail).join("; ")).toContain("USING INDEX claude_events_remembered_identity");
    const discovery = resolveVendorDiscovery([{ vendor: "claude", key, email: "account@example.com", plan: "pro", machine: "NEW-PC", login: "new", home: "D:/new/.claude", revision: "test" } as any], [], remembered, "NEW-PC");
    expect(discovery.accounts).toHaveLength(1);
    expect(discovery.accounts[0]).toMatchObject({ id, email: "account@example.com", current: true });
  } finally { sqlite.close(); }
});
