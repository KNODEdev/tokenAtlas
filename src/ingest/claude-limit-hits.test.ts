import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../db/schema";
import { applyDrizzleMigrations } from "../db/migrate";
import { replaceClaudeFileLimitHits } from "./claude";
import { parseClaudeFixture } from "./native-test-support";
import { claudeAccountKey, claudeIdentitySubscription } from "./claude-identity";
import type { NewClaudeLimitHit } from "../db/schema";

const account = "6deed05f-c0a9-41d1-8e7f-fd5baaa36db2", org = "bd47f8bf-640e-4156-ad4a-4d6650376a59";
const session = "4b486c27-4f4f-486a-a380-ba9072412f01";
const key = claudeAccountKey(account, org)!;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function write(rows: unknown[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-limit-")); dirs.push(dir);
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n"));
  return file;
}
const owner = { type: "bridge-session", sessionId: session, ownerAccountUuid: account, ownerOrganizationUuid: org };
const call = { type: "assistant", sessionId: session, timestamp: "2026-09-23T21:40:00.000Z",
  message: { id: "msg-1", model: "claude-opus-5-5", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } } };
// The shape Claude Code 2.1.280 writes when the weekly limit refuses a request.
const refusal = (uuid: string, timestamp: string, quotaLimits: Record<string, unknown>) => ({
  type: "assistant", uuid, sessionId: session, timestamp, requestId: `req-${uuid}`, error: "rate_limit", isApiErrorMessage: true, apiErrorStatus: 429,
  message: { id: `synthetic-${uuid}`, model: "<synthetic>", role: "assistant", stop_reason: "stop_sequence", type: "message",
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    content: [{ type: "text", text: "You've hit your weekly limit · resets Sep 27, 1pm (Europe/Warsaw)" }] },
  quotaLimits,
});
const weekly = { status: "rejected", resetsAt: 1790506800, unifiedRateLimitFallbackAvailable: true, rateLimitType: "seven_day",
  overageStatus: "rejected", overageDisabledReason: "org_level_disabled", upgradePaths: ["upgrade_plan"], isUsingOverage: false };

test("a limit refusal becomes a dated reading of its counter, owned like the session's events", async () => {
  const hits: NewClaudeLimitHit[] = [];
  const file = write([owner, call, refusal("a", "2026-09-23T21:46:18.888Z", weekly),
    refusal("b", "2026-09-24T02:00:00.000Z", { ...weekly, rateLimitType: "five_hour", resetsAt: 1790218800 }),
    // Not refusals: an allowed status, a type outside the vendor's vocabulary, no quota at all.
    refusal("c", "2026-09-24T03:00:00.000Z", { ...weekly, status: "allowed" }),
    refusal("d", "2026-09-24T03:10:00.000Z", { ...weekly, rateLimitType: "Weekly Limit!" }),
    { ...refusal("e", "2026-09-24T03:20:00.000Z", weekly), quotaLimits: undefined, error: "other" }]);
  const events = await parseClaudeFixture("live", file, undefined, hits);

  // The refusal stays an event of its own as before (zero tokens), so events are unchanged.
  expect(events.map((event) => event.call_id).sort()).toEqual(["msg-1", "synthetic-a", "synthetic-b", "synthetic-c", "synthetic-d", "synthetic-e"]);
  expect(hits).toEqual([
    { store: "live", call_id: "synthetic-a", session_id: session, ts: "2026-09-23T21:46:18.888Z", limit_type: "seven_day",
      status: "rejected", type_basis: "vendor", resets_at: "2026-09-27T11:00:00.000Z", path: file, subscription_id: claudeIdentitySubscription(key),
      account_key: key, subscription_conflict: 0 },
    expect.objectContaining({ call_id: "synthetic-b", limit_type: "five_hour", resets_at: "2026-09-24T03:00:00.000Z" }),
  ]);
  // Without a collector the parser reads exactly what it read before.
  expect(await parseClaudeFixture("live", file)).toEqual(events);
});

test("historical refusal text resolves explicit dates, local times, DST and inferred types", async () => {
  const cases = [
    ["You've hit your weekly limit · resets Jun 14, 1pm (Europe/Warsaw)", "2026-06-12T09:00:00Z", "seven_day", "2026-06-14T11:00:00.000Z", "text"],
    ["You've hit your weekly limit · resets Sep 27, 1pm (Europe/Warsaw)", "2026-09-23T21:46:18Z", "seven_day", "2026-09-27T11:00:00.000Z", "text"],
    ["You've hit your weekly limit · resets 1pm (Europe/Warsaw)", "2026-08-20T09:00:00Z", "seven_day", "2026-08-20T11:00:00.000Z", "text"],
    ["You've hit your session limit · resets 1:20pm (Europe/Warsaw)", "2026-05-28T09:00:00Z", "five_hour", "2026-05-28T11:20:00.000Z", "text"],
    ["You've hit your limit · resets 8am (Europe/Warsaw)", "2026-03-07T10:03:23Z", "seven_day", "2026-03-08T07:00:00.000Z", "inferred_from_reset"],
    ["You've hit your limit · resets Mar 8, 8am (Europe/Warsaw)", "2026-03-07T10:03:23Z", "seven_day", "2026-03-08T07:00:00.000Z", "inferred_from_reset"],
    ["You've hit your limit · resets 2pm (Europe/Warsaw)", "2026-01-15T12:44:58Z", "five_hour", "2026-01-15T13:00:00.000Z", "inferred_from_reset"],
    ["You've hit your session limit · resets 2:30am (Europe/Warsaw)", "2026-10-24T23:30:00Z", "five_hour", "2026-10-25T00:30:00.000Z", "text"],
    ["You've hit your session limit · resets 3:30am (Europe/Warsaw)", "2026-03-29T00:30:00Z", "five_hour", "2026-03-29T01:30:00.000Z", "text"],
    ["You've hit your session limit · resets 1pm (America/New_York)", "2026-06-14T15:00:00Z", "five_hour", "2026-06-14T17:00:00.000Z", "text"],
  ] as const;
  for (const [message, at, limitType, resetsAt, typeBasis] of cases) {
    const hits: NewClaudeLimitHit[] = [];
    await parseClaudeFixture("live", write([{ type: "assistant", timestamp: at, sessionId: session, error: "rate_limit", isApiErrorMessage: true,
      message: { id: "refusal", model: "claude-opus-5", content: [{ type: "text", text: message }] } }]), undefined, hits);
    expect(hits[0]).toMatchObject({ limit_type: limitType, resets_at: resetsAt, type_basis: typeBasis });
  }

  for (const message of ["You've hit your session limit", "You've hit your limit · resets 2:30am (Invalid/Zone)"]) {
    const rejected: NewClaudeLimitHit[] = [];
    await parseClaudeFixture("live", write([{ type: "assistant", timestamp: "2026-05-28T09:00:00Z", sessionId: session,
      error: "rate_limit", isApiErrorMessage: true, message: { id: "unknown-reset", content: [{ type: "text", text: message }] } }]), undefined, rejected);
    expect(rejected).toEqual([]);
  }

  const hits: NewClaudeLimitHit[] = [];
  const textOnly = { ...refusal("text", "2026-03-07T10:03:23.098Z", weekly), quotaLimits: undefined,
    message: { ...refusal("text", "2026-03-07T10:03:23.098Z", weekly).message,
      content: [{ type: "text", text: cases[4][0] }] } };
  const file = write([owner, textOnly, textOnly,
    { ...textOnly, uuid: "ignored", message: { ...textOnly.message, id: "ignored" }, isApiErrorMessage: false },
    { ...textOnly, uuid: "structured", message: { ...textOnly.message, id: "structured" }, quotaLimits: weekly }]);
  await parseClaudeFixture("live", file, undefined, hits);
  expect(hits).toHaveLength(2);
  expect(hits[0]).toMatchObject({ call_id: "synthetic-text", limit_type: "seven_day", type_basis: "inferred_from_reset",
    resets_at: "2026-03-08T07:00:00.000Z" });
  expect(hits[1]).toMatchObject({ call_id: "structured", type_basis: "vendor", resets_at: "2026-09-27T11:00:00.000Z" });
  const sameCall: NewClaudeLimitHit[] = [];
  await parseClaudeFixture("live", write([owner, textOnly, { ...textOnly, quotaLimits: weekly }]), undefined, sameCall);
  expect(sameCall).toHaveLength(1);
  expect(sameCall[0]).toMatchObject({ type_basis: "vendor", resets_at: "2026-09-27T11:00:00.000Z" });
});

test("a reread file replaces its refusals; a refusal repeated in another file of the store moves to it", async () => {
  const sqlite = new Database(":memory:");
  applyDrizzleMigrations(drizzle(sqlite, { schema }), path.resolve(import.meta.dir, "../../drizzle"));
  const hit = (callId: string, file: string): NewClaudeLimitHit => ({ store: "live", call_id: callId, ts: "2026-09-23T21:46:18.888Z",
    limit_type: "seven_day", status: "rejected", resets_at: "2026-09-27T11:00:00.000Z", path: file });
  replaceClaudeFileLimitHits(sqlite, "live", "a.jsonl", [hit("x", "a.jsonl"), hit("y", "a.jsonl")]);
  replaceClaudeFileLimitHits(sqlite, "live", "a.jsonl", [hit("x", "a.jsonl")]);
  replaceClaudeFileLimitHits(sqlite, "live", "b.jsonl", [hit("x", "b.jsonl")]);
  expect(sqlite.query("SELECT call_id, path FROM claude_limit_hits ORDER BY call_id").all()).toEqual([{ call_id: "x", path: "b.jsonl" }]);
  sqlite.close();
});
