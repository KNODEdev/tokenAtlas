import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "./sqlite";
import { createCodexLedgerSchema } from "./codex-price-ledger";
import { enqueueCodexLedgerRuleChanges, markCodexLedgerCopiesDirty, processCodexLedgerBatch, type LedgerProducerOptions } from "./codex-ledger-producer";
import { ledgerCopyAnchorFromArchive } from "./codex-ledger-copies";
import { compileCodexLedgerPolicy, type CodexLedgerPolicy } from "../server/codex-ledger-policy";
import { ensureCodexSchema, syncCodex } from "../ingest/codex";
import { bindCanonicalArchiveRoot } from "../config/archive-paths";
import { codexReadingEvidenceSql } from "./codex-ledger-canonical";
import { ensureLimitWindowSchema } from "./limit-windows";
import { loadCapacitySessionProbes } from "../server/codex-capacity-probes";

/**
 * A forked Codex thread (alphas up to 0.149) opens with its parent's token counts replayed at the fork time,
 * without response ids. The ledger counts them once, in the parent (docs/verification/codex-fork-copies-2026-10-06.md).
 */
const PARENT = "019f51e3-efe2-7a22-aeea-6c78d82fbe97", FORK = "019f51e6-aee1-7f03-b046-1438cbd3d001", COPY = "01a11012-ce9b-7680-8411-f0e7915767ea";
const provenance = { verified_at: "2026-01-01", sources: ["https://example.com/prices"], confidence: "official" as const };
const policy: CodexLedgerPolicy = { version: 1, tiers: ["standard"], mappings: [{ id: "default", raw_value: "default", tier: "standard" }],
  base_rules: [
    { id: "api", model: "m", billing_basis: "api_equivalent_usd", valid_from: "2026-01-01", multiplier: "1",
      rates: { in_uncached: "1", in_cache_read: "0.1", out_total: "8" }, ...provenance },
    { id: "credits", model: "m", billing_basis: "chatgpt_credits", valid_from: "2026-01-01", multiplier: "1",
      rates: { in_uncached: "25", in_cache_read: "2.5", out_total: "200" }, ...provenance },
  ], tier_rules: [
    { id: "api-standard", model: "m", billing_basis: "api_equivalent_usd", tier: "standard", valid_from: "2026-01-01", multiplier: "1", ...provenance },
    { id: "credit-standard", model: "m", billing_basis: "chatgpt_credits", tier: "standard", valid_from: "2026-01-01", multiplier: "1", ...provenance },
  ] };
const line = (value: unknown) => JSON.stringify(value) + "\n";
const meta = (ts: string, id: string, forkedFrom?: string) => line({ timestamp: ts, type: "session_meta",
  payload: { id, originator: "Codex Desktop", cli_version: "0.145.0-alpha.18", thread_source: "user", ...(forkedFrom ? { forked_from_id: forkedFrom } : {}) } });
const turn = (ts: string) => line({ timestamp: ts, type: "turn_context", payload: { model: "m" } });
/**
 * A token count of one call: `[input, output]` of the call and the thread's running total before it, with the
 * weekly meter reading the record carried (a percentage that follows the running total, so a replay repeats it).
 */
function counts(calls: Array<{ ts: string; input: number; output: number }>, total = { input: 0, output: 0 }): string {
  return calls.map(call => {
    total.input += call.input; total.output += call.output;
    const usage = (input: number, output: number) => ({ input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0,
      output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
    return line({ timestamp: call.ts, type: "event_msg", payload: { type: "token_count", info: {
      total_token_usage: usage(total.input, total.output), last_token_usage: usage(call.input, call.output) },
      rate_limits: { limit_id: "codex", plan_type: "pro", primary: { used_percent: Math.round(total.input / 10_000),
        window_minutes: 10080, resets_at: 1784354641 } } } });
  }).join("");
}
const parentCalls = [
  { ts: "2026-07-11T15:55:34.298Z", input: 18464, output: 278 }, { ts: "2026-07-11T15:55:38.176Z", input: 26540, output: 129 },
  { ts: "2026-07-11T15:55:46.132Z", input: 33546, output: 307 }];
const laterParentCall = { ts: "2026-07-11T16:10:00.000Z", input: 41000, output: 90 };
const forkOwn = [{ ts: "2026-07-11T15:58:37.088Z", input: 18443, output: 254 }, { ts: "2026-07-11T15:58:41.468Z", input: 18777, output: 157 }];
// The fork replays the parent's calls within one millisecond of its creation, then makes its own calls.
const replayed = parentCalls.map((call, index) => ({ ...call, ts: `2026-07-11T15:58:30.54${4 + Math.min(index, 1)}Z` }));
const parentText = meta("2026-07-11T15:55:26.157Z", PARENT) + turn("2026-07-11T15:55:26.741Z") + counts(parentCalls);
const forkText = (own = forkOwn) => {
  const total = { input: 0, output: 0 };
  return meta("2026-07-11T15:58:30.544Z", FORK, PARENT) + counts(replayed, total) + turn("2026-07-11T15:58:30.591Z") + counts(own, total);
};
// Codex 0.160 "copy thread": the parent's session id, the new id only in the file name, no replayed counts.
const copyText = meta("2026-07-11T16:20:00.000Z", PARENT) + turn("2026-07-11T16:20:00.100Z")
  + counts([{ ts: "2026-07-11T16:20:10.000Z", input: 18464, output: 278 }, { ts: "2026-07-11T16:20:20.000Z", input: 26540, output: 129 }]);

async function withArchive(run: (archive: {
  db: Database; write(name: string, text: string): string; sync(files: string[]): Promise<void>; drain(): void;
  totals(): { calls: number; input: number; output: number }; states(): Array<{ file: string; offset: number; identity: string; state: string }>;
  sums(): number;
}) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "codex-fork-replays-")), home = path.join(directory, "codex");
  const folder = path.join(home, "sessions", "2026", "07", "11"), db = new Database(":memory:");
  fs.mkdirSync(folder, { recursive: true });
  const binding = bindCanonicalArchiveRoot(null, "fork-archive", directory);
  const options: LedgerProducerOptions = { bands: compileCodexLedgerPolicy(policy).baseBands, policy, factsRevision: 0,
    rulesRevision: createHash("sha256").update(JSON.stringify(policy)).digest("hex"), batchSize: 50,
    anchorOf: (_home, file) => ledgerCopyAnchorFromArchive(binding, "codex/synthetic", file) };
  try {
    ensureCodexSchema(db); createCodexLedgerSchema(db); ensureLimitWindowSchema(db);
    enqueueCodexLedgerRuleChanges(db, options);
    await run({
      db,
      write: (name, text) => { const file = path.join(folder, name); fs.writeFileSync(file, text); return file; },
      sync: async files => {
        await syncCodex(db, { homes: [home], files });
        db.transaction(() => markCodexLedgerCopiesDirty(db, files.map(file => ({ home, path: file })))).immediate();
      },
      drain: () => {
        for (let step = 0; step < 200; step++) if (processCodexLedgerBatch(db, options).ready) return;
        throw new Error("Producer did not finish");
      },
      totals: () => db.query(`SELECT COUNT(*) calls,SUM(in_tok) input,SUM(out_tok) output FROM codex_price_ledger_events
        WHERE copy_state='canonical'`).get() as { calls: number; input: number; output: number },
      states: () => db.query(`SELECT substr(c.relative_path,-12) file,e.source_offset offset,e.identity,e.copy_state state
        FROM codex_price_ledger_events e JOIN codex_price_ledger_copies c ON c.id=e.copy_id ORDER BY c.relative_path,e.source_offset`).all() as never,
      sums: () => (db.query("SELECT SUM(calls) n FROM codex_price_ledger_aggregates WHERE grain='day' AND copy_state='canonical'").get() as { n: number }).n,
    });
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}
const sum = (calls: Array<{ input: number; output: number }>) => ({ calls: calls.length,
  input: calls.reduce((a, call) => a + call.input, 0), output: calls.reduce((a, call) => a + call.output, 0) });
const expected = (...groups: Array<Array<{ input: number; output: number }>>) => sum(groups.flat());

test("the parser names a fork's parent and the ledger counts the replayed calls once, in the parent", async () => withArchive(async archive => {
  const parent = archive.write(`rollout-2026-07-11T17-55-25-${PARENT}.jsonl`, parentText);
  const fork = archive.write(`rollout-2026-07-11T17-58-25-${FORK}.jsonl`, forkText());
  await archive.sync([parent, fork]);
  expect(archive.db.query("SELECT substr(path,-42) file,provider_session_id,provider_forked_from_id FROM codex_file_evidence ORDER BY path").all())
    .toEqual([{ file: `${PARENT}.jsonl`, provider_session_id: PARENT, provider_forked_from_id: null },
      { file: `${FORK}.jsonl`, provider_session_id: FORK, provider_forked_from_id: PARENT }]);
  expect(archive.db.query("SELECT COUNT(*) n FROM events").get()).toEqual({ n: 3 + 3 + 2 });
  archive.drain();
  // Totals equal the parent's calls plus the fork's own calls; the replay is a duplicate pointing at the original.
  expect(archive.totals()).toEqual(expected(parentCalls, forkOwn));
  expect(archive.sums()).toBe(5);
  const states = archive.states();
  const parentOffsets = states.filter(row => row.file.endsWith(`${PARENT.slice(-6)}.jsonl`)).map(row => row.offset);
  const replays = states.filter(row => row.state === "duplicate");
  expect(replays.map(row => row.identity)).toEqual(parentOffsets.map(offset =>
    `c:codex/synthetic|rollout-2026-07-11t17-55-25-${PARENT}.jsonl|${offset}`));
  expect(states.filter(row => row.state === "canonical")).toHaveLength(5);
}));

test("a fork imported before its parent is resolved again when the parent arrives; appends keep one count", async () => withArchive(async archive => {
  const fork = archive.write(`rollout-2026-07-11T17-58-25-${FORK}.jsonl`, forkText());
  await archive.sync([fork]);
  archive.drain();
  // Without the parent's calls the fork's calls are all it shows: nothing is dropped.
  expect(archive.totals()).toEqual(expected(parentCalls, forkOwn));
  const parent = archive.write(`rollout-2026-07-11T17-55-25-${PARENT}.jsonl`, parentText);
  await archive.sync([parent]);
  archive.drain();
  expect(archive.totals()).toEqual(expected(parentCalls, forkOwn));
  expect(archive.sums()).toBe(5);
  // The parent goes on after the fork, and the fork makes one more call: each counts once.
  const extra = { ts: "2026-07-11T16:00:00.000Z", input: 20000, output: 300 };
  fs.appendFileSync(parent, counts([laterParentCall], { input: 78550, output: 714 }));
  fs.writeFileSync(fork, forkText([...forkOwn, extra]));
  await archive.sync([parent, fork]);
  archive.drain();
  expect(archive.totals()).toEqual(expected(parentCalls, [laterParentCall], forkOwn, [extra]));
  expect(archive.sums()).toBe(7);
  expect(archive.states().filter(row => row.state === "duplicate")).toHaveLength(3);
}));

test("a 0.160 thread copy (parent's session id, new id in the file name, no replay) counts all its calls", async () => withArchive(async archive => {
  const parent = archive.write(`rollout-2026-07-11T17-55-25-${PARENT}.jsonl`, parentText);
  // Its calls even repeat the parent's token counts: without forked_from_id they are its own.
  const copy = archive.write(`rollout-2026-07-11T18-20-00-${PARENT}_${COPY}.jsonl`, copyText);
  await archive.sync([parent, copy]);
  archive.drain();
  expect(archive.db.query("SELECT COUNT(DISTINCT conversation) n FROM codex_price_ledger_copies").get()).toEqual({ n: 2 });
  expect(archive.totals()).toEqual({ calls: 5, input: 18464 + 26540 + 33546 + 18464 + 26540, output: 278 + 129 + 307 + 278 + 129 });
  expect(archive.states().every(row => row.state === "canonical")).toBe(true);
}));

test("a reading of a replayed record is not meter evidence; the fork's limit windows are derived again", async () => withArchive(async archive => {
  const parent = archive.write(`rollout-2026-07-11T17-55-25-${PARENT}.jsonl`, parentText);
  const fork = archive.write(`rollout-2026-07-11T17-58-25-${FORK}.jsonl`, forkText());
  await archive.sync([parent, fork]);
  const evidence = () => archive.db.query(`SELECT substr(r.path,-20) file,r.ts,r.used_percent FROM ratelimit r
    WHERE ${codexReadingEvidenceSql(archive.db, "r")} ORDER BY r.ts`).all() as Array<{ file: string; ts: string; used_percent: number }>;
  // Before the ledger resolved the fork every reading counts; after, the replayed ones (parent's 2, 5 and 8 % again
  // at 15:58:30) do not, while the parent's originals and the fork's own readings stay.
  expect(evidence()).toHaveLength(3 + 3 + 2);
  archive.drain();
  expect(archive.db.query("SELECT COUNT(*) n FROM ratelimit").get()).toEqual({ n: 8 });
  expect(evidence().map(row => [row.file.endsWith(`${PARENT.slice(-7)}.jsonl`) ? "parent" : "fork", row.ts, row.used_percent])).toEqual([
    ["parent", "2026-07-11T15:55:34.298Z", 2], ["parent", "2026-07-11T15:55:38.176Z", 5], ["parent", "2026-07-11T15:55:46.132Z", 8],
    ["fork", "2026-07-11T15:58:37.088Z", 10], ["fork", "2026-07-11T15:58:41.468Z", 12]]);
  const probes = loadCapacitySessionProbes(archive.db, "2026-07-11", "2026-07-12", () => "codex1");
  expect(probes.map(probe => probe.ts)).toEqual(evidence().map(row => row.ts));
  // The fork's resolution queued its file for the limit windows.
  const queued = (archive.db.query("SELECT account FROM limit_window_dirty WHERE kind='file'").all() as { account: string }[])
    .map(row => (JSON.parse(row.account) as [string, string])[1]);
  expect(queued.some(file => file.endsWith(`${FORK}.jsonl`))).toBe(true);
}));
