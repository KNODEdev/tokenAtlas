/** Repeatable two-year Grok/GLM consumer benchmark; never opens production data or configuration. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../src/db/sqlite";
import type { RateCard } from "../src/server/pricing";
import { installFactDayRevisions } from "../src/db/fact-day-revisions";

const CHILD = process.argv[2] === "--restart-child";
const outputPath = CHILD ? null : process.argv[2];
if (!CHILD && !outputPath) {
  throw new Error("Usage: bun scripts/benchmark-provider-consumers.ts <output.json>");
}

const sandbox = CHILD ? process.argv[4]! : fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-provider-benchmark-"));
const configRoot = path.join(sandbox, "config");
const archiveRoot = path.join(sandbox, "archive");
fs.mkdirSync(configRoot, { recursive: true });
fs.mkdirSync(archiveRoot, { recursive: true });
if (!CHILD) fs.writeFileSync(path.join(configRoot, "projects.json"), JSON.stringify({ projects: [] }));
process.env.TOKENATLAS_CONFIG = configRoot;
process.env.TOKENATLAS_ARCHIVE = archiveRoot;
process.env.TOKENATLAS_LOCAL_STATE = path.join(sandbox, "local-state");
process.env.TOKENATLAS_FROZEN_CONFIG = "1";
process.env.TOKENATLAS_MACHINE = "provider-benchmark-machine";
process.env.TOKENATLAS_LOGIN = "provider-benchmark-login";

const [
  { createTestDatabase },
  { installAnalysisTracking },
  { fillUsageLedger },
  { measureAnalysis },
  { buildEraIndex },
  { storedProjectUsage },
  { buildProjectCost },
  { buildRepoHistory, listSubjects },
] = await Promise.all([
  import("../src/sync/test-support"),
  import("../src/db/analysis"),
  import("../src/server/usage-ledger.fixture"),
  import("../src/server/claude-code-capacity.fixture"),
  import("../src/server/eras"),
  import("../src/server/stored-project-usage"),
  import("../src/server/project-cost"),
  import("../src/server/repo-history"),
]);

const DAYS = 730;
const SUBJECTS = ["alpha", "beta"] as const;
const UNTIL = "2026-09-02";
const SINCE = new Date(Date.parse(`${UNTIL}T00:00:00.000Z`) - (DAYS - 1) * 86_400_000)
  .toISOString().slice(0, 10);
const PERIOD = { since: SINCE, until: UNTIL };
const SAMPLES = 25;
const GROK_ACCOUNT = "grok-seat";
const GLM_ACCOUNT = "glm-seat";

const rates: RateCard = {
  version: 1,
  currency: "USD",
  unit: "per 1M",
  vendors: {
    xai: { source: "synthetic-independent", models: {
      "grok-benchmark": { in_uncached: 2, in_cache_read: 1, in_cache_write: 3, out_total: 4 },
    } },
    zai: { source: "synthetic-independent", models: {
      "glm-benchmark": { in_uncached: 1, in_cache_read: 2, in_cache_write: 4, out_total: 5 },
    } },
  },
  subscriptions: {
    [GROK_ACCOUNT]: { usd_per_month: 30 },
    [GLM_ACCOUNT]: { usd_per_month: 60 },
  },
};

const eras = buildEraIndex([
  { id: GROK_ACCOUNT, vendor: "grok", home: "grok-original", source_home: "grok-copy" },
  { id: GLM_ACCOUNT, vendor: "glm", home: "glm-original", source_home: "glm-copy" },
]);

// These expectations are deliberately derived independently of the implementation:
// Grok = (1000-200)+200+30+100 = 1130 tokens;
//         800*2 + 200*1 + 30*3 + 100*4 = 2290 micro-dollars.
// GLM  = 900+100+20+(80+40) = 1140 tokens;
//         900*1 + 100*2 + 20*4 + 120*5 = 1780 micro-dollars.
const GROK_EVENT = { tokens: 1_130, apiUsd: 0.00229, reportedUsd: 0.007 };
const GLM_EVENT = { tokens: 1_140, apiUsd: 0.00178, reportedUsd: 0.009 };
const LATE_GROK_EVENT = { tokens: 1_001_130, apiUsd: 2.00229, reportedUsd: 0.017 };
const TOKEN_CORRECTION = { tokens: 1_000, apiUsd: 0.002 };
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const closeTo = (actual: number, expected: number, message: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, received ${actual}`);

interface Expected {
  grok: { calls: number; tokens: number; apiUsd: number; reportedUsd: number };
  glm: { calls: number; tokens: number; apiUsd: number; reportedUsd: number };
  subjects: Record<string, {
    calls: number;
    tokens: number;
    grokTokens: number;
    glmTokens: number;
    grokApiUsd: number;
    glmApiUsd: number;
  }>;
}

function baseExpected(): Expected {
  const perProviderCalls = DAYS * SUBJECTS.length;
  const subject = () => ({
    calls: DAYS * 2,
    tokens: DAYS * (GROK_EVENT.tokens + GLM_EVENT.tokens),
    grokTokens: DAYS * GROK_EVENT.tokens,
    glmTokens: DAYS * GLM_EVENT.tokens,
    grokApiUsd: DAYS * GROK_EVENT.apiUsd,
    glmApiUsd: DAYS * GLM_EVENT.apiUsd,
  });
  return {
    grok: {
      calls: perProviderCalls,
      tokens: perProviderCalls * GROK_EVENT.tokens,
      apiUsd: perProviderCalls * GROK_EVENT.apiUsd,
      reportedUsd: perProviderCalls * GROK_EVENT.reportedUsd,
    },
    glm: {
      calls: perProviderCalls,
      tokens: perProviderCalls * GLM_EVENT.tokens,
      apiUsd: perProviderCalls * GLM_EVENT.apiUsd,
      reportedUsd: perProviderCalls * GLM_EVENT.reportedUsd,
    },
    subjects: { alpha: subject(), beta: subject() },
  };
}

function ensureColumns(db: Database): void {
  for (const table of ["grok_events", "oc_events"]) {
    const columns = new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map(row => row.name));
    for (const column of ["repo", "repo_group"]) {
      if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    }
  }
}

function prepare(db: Database, providers: Array<["grok" | "glm", string]>): Record<string, number> {
  const calls: Record<string, number> = {};
  for (const [provider, account] of providers) {
    fillUsageLedger(db, provider, rates, archiveRoot, 500);
    calls[`${provider}/${account}`] = 1;
  }
  return calls;
}

interface ProviderSnapshot {
  calls: number;
  tokens: number;
  api_usd: number;
}
interface ConsumerSnapshot {
  project: {
    calls: number;
    tokens: number;
    api_usd: number;
    api_complete: boolean | undefined;
    subjects: Array<{ subject: string; tokens: number; by_sub: Record<string, number> }>;
  };
  history: {
    calls: number;
    tokens: number;
    api_usd: number;
    api_complete: boolean;
    active_seconds: number;
    by_sub: Record<string, number>;
    split: Record<string, { calls: number; tokens: number }>;
    buckets: number;
  };
  selector: Array<{ id: string; calls: number; tokens: number; active_seconds: number; repos: string[] }>;
  providers: { grok: ProviderSnapshot; glm: ProviderSnapshot };
}

function providerSnapshot(usage: ReturnType<typeof storedProjectUsage>): ProviderSnapshot {
  return {
    calls: usage.groups.reduce((sum, row) => sum + row.calls, 0) +
      usage.unpriced.reduce((sum, row) => sum + row.calls, 0),
    tokens: usage.groups.reduce((sum, row) => sum + row.tokens, 0) +
      usage.unpriced.reduce((sum, row) => sum + row.tokens, 0),
    api_usd: usage.groups.reduce((sum, row) => sum + row.api_usd, 0),
  };
}

function runConsumers(db: Database): ConsumerSnapshot {
  // Every consumer reads the same usage ledger valuations; none prices the facts itself.
  const project = buildProjectCost(db, rates, new Map(), { ...PERIOD, eras });
  const history = buildRepoHistory(db, {
    ...PERIOD,
    eras,
    rateCards: rates,
    homeToSubId: new Map(),
    projectId: "alpha",
    repo: null,
    granularity: "month",
    by: "account",
    idleGapMinutes: 15,
  });
  const selector = listSubjects(db, 15, PERIOD, { eras, rateCards: rates });
  const grok = storedProjectUsage(db, "grok", rates, PERIOD);
  const glm = storedProjectUsage(db, "glm", rates, PERIOD);
  const split: ConsumerSnapshot["history"]["split"] = {};
  for (const point of history.points) {
    for (const [account, row] of Object.entries(point.split ?? {})) {
      const current = split[account] ?? { calls: 0, tokens: 0 };
      current.calls += row.calls;
      current.tokens += row.tokens;
      split[account] = current;
    }
  }
  return {
    project: {
      calls: project.totals.calls,
      tokens: project.totals.tokens,
      api_usd: project.totals.api_usd,
      api_complete: project.totals.api_complete,
      subjects: project.subjects.map(row => ({
        subject: row.subject,
        tokens: row.tokens,
        by_sub: row.by_sub,
      })).sort((a, b) => a.subject.localeCompare(b.subject)),
    },
    history: {
      calls: history.totals.calls,
      tokens: history.totals.tokens,
      api_usd: history.totals.api_usd,
      api_complete: history.totals.api_complete,
      active_seconds: history.totals.active_seconds,
      by_sub: Object.fromEntries(Object.entries(history.totals.by_sub)
        .map(([account, value]) => [account, value.api_usd])),
      split,
      buckets: history.points.length,
    },
    selector: selector.filter(row => SUBJECTS.includes(row.id as typeof SUBJECTS[number]))
      .map(row => ({ id: row.id, calls: row.calls, tokens: row.tokens,
        active_seconds: row.active_seconds, repos: row.repos }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    providers: { grok: providerSnapshot(grok), glm: providerSnapshot(glm) },
  };
}

interface Sample {
  ms: number;
  raw_or_fact_queries: number;
  value: ConsumerSnapshot;
}
function sample(db: Database): Sample {
  const started = performance.now();
  const measured = measureAnalysis(db, () => runConsumers(db));
  return {
    ms: round3(performance.now() - started),
    raw_or_fact_queries: measured.rawOrFactQueries.length,
    value: measured.value,
  };
}

function assertExpected(value: ConsumerSnapshot, expected: Expected): void {
  const expectedCalls = expected.grok.calls + expected.glm.calls;
  const expectedTokens = expected.grok.tokens + expected.glm.tokens;
  const expectedApi = expected.grok.apiUsd + expected.glm.apiUsd;
  assert.equal(value.project.calls, expectedCalls);
  assert.equal(value.project.tokens, expectedTokens);
  assert.equal(value.project.api_usd, round2(expectedApi));
  assert.equal(value.project.api_complete, true);

  for (const subjectName of SUBJECTS) {
    const wanted = expected.subjects[subjectName]!;
    const projectSubject = value.project.subjects.find(row => row.subject === `p:${subjectName}`);
    assert.ok(projectSubject, `Missing project subject ${subjectName}`);
    assert.equal(projectSubject.tokens, wanted.tokens);
    assert.equal(projectSubject.by_sub[GROK_ACCOUNT], round2(wanted.grokApiUsd));
    assert.equal(projectSubject.by_sub[GLM_ACCOUNT], round2(wanted.glmApiUsd));
    const selectorSubject = value.selector.find(row => row.id === subjectName);
    assert.ok(selectorSubject, `Missing selector subject ${subjectName}`);
    assert.equal(selectorSubject.calls, wanted.calls);
    assert.equal(selectorSubject.tokens, wanted.tokens);
    assert.equal(selectorSubject.active_seconds, 0);
    assert.deepEqual(selectorSubject.repos, [`repo-${subjectName}`]);
  }

  const alpha = expected.subjects.alpha!;
  assert.equal(value.history.calls, alpha.calls);
  assert.equal(value.history.tokens, alpha.tokens);
  assert.equal(value.history.api_usd, round2(alpha.grokApiUsd + alpha.glmApiUsd));
  assert.equal(value.history.api_complete, true);
  assert.equal(value.history.active_seconds, 0);
  assert.equal(value.history.split[GROK_ACCOUNT]?.calls, alpha.calls - DAYS);
  assert.equal(value.history.split[GROK_ACCOUNT]?.tokens, alpha.grokTokens);
  assert.equal(value.history.split[GLM_ACCOUNT]?.calls, DAYS);
  assert.equal(value.history.split[GLM_ACCOUNT]?.tokens, alpha.glmTokens);
  assert.equal(value.history.by_sub[GROK_ACCOUNT], round2(alpha.grokApiUsd));
  assert.equal(value.history.by_sub[GLM_ACCOUNT], round2(alpha.glmApiUsd));

  for (const [provider, wanted] of [["grok", expected.grok], ["glm", expected.glm]] as const) {
    const actual = value.providers[provider];
    assert.equal(actual.calls, wanted.calls);
    assert.equal(actual.tokens, wanted.tokens);
    closeTo(actual.api_usd, wanted.apiUsd, `${provider} configured API valuation`);
  }
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}
function distribution(samples: Sample[]) {
  assert.ok(samples.length >= 20, "Timing distributions require at least 20 samples");
  const milliseconds = samples.map(row => row.ms);
  return {
    count: samples.length,
    p50_ms: percentile(milliseconds, 0.50),
    p95_ms: percentile(milliseconds, 0.95),
    min_ms: Math.min(...milliseconds),
    max_ms: Math.max(...milliseconds),
    samples: samples.map(row => ({
      ms: row.ms,
      raw_or_fact_queries: row.raw_or_fact_queries,
    })),
  };
}

function collectSamples(db: Database): { reads: Sample[]; summary: ReturnType<typeof distribution> } {
  const reads: Sample[] = [];
  for (let index = 0; index < SAMPLES; index++) reads.push(sample(db));
  return { reads, summary: distribution(reads) };
}

if (CHILD) {
  const dbPath = process.argv[3]!;
  const db = new Database(dbPath);
  try {
    const reopened = collectSamples(db);
    console.log(JSON.stringify({ summary: reopened.summary, reference: reopened.reads[0]!.value }));
  } finally {
    db.close(true);
  }
} else {
  const created = createTestDatabase();
  let db = new Database(created.dbPath);
  try {
    db.exec("PRAGMA journal_mode=WAL");
    ensureColumns(db);
    installAnalysisTracking(db);
    installFactDayRevisions(db);
    for (const [provider,source,account] of [["grok","grok/benchmark",GROK_ACCOUNT],["glm","glm/glm-original",GLM_ACCOUNT],["glm","glm/glm-copy",GLM_ACCOUNT]])
      db.query("INSERT INTO account_periods(provider,source,from_ts,account,origin,evidence) VALUES(?,?,'2020-01-01',?,'declared','synthetic')").run(provider!,source!,account!);

    const grokInsert = db.query(`INSERT INTO grok_events(
      store,source_id,session_id,prompt_id,model,ts,path,in_tok,cached_in,cache_write,
      out_tok,reasoning,project_id,repo,repo_group,cost_ticks)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const glmInsert = db.query(`INSERT INTO oc_events(
      store,message_id,session_id,ts,model,provider,project_id,repo,repo_group,
      in_tok,out_tok,reasoning,cache_read,cache_write,cost)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    db.transaction(() => {
      for (let day = 0; day < DAYS; day++) {
        const date = new Date(Date.parse(`${SINCE}T00:00:00.000Z`) + day * 86_400_000)
          .toISOString().slice(0, 10);
        for (let subjectIndex = 0; subjectIndex < SUBJECTS.length; subjectIndex++) {
          const subject = SUBJECTS[subjectIndex]!;
          const grokIdentity = `grok-${day}-${subject}`;
          const glmIdentity = `glm-${day}-${subject}`;
          const grokTs = `${date}T${String(10 + subjectIndex).padStart(2, "0")}:00:00.000Z`;
          const glmTs = `${date}T${String(14 + subjectIndex).padStart(2, "0")}:00:00.000Z`;
          for (const [store, source] of [["grok-original", "original"], ["grok-copy", "replica"]] as const) {
            grokInsert.run(store, `${source}-${grokIdentity}`, grokIdentity, grokIdentity,
              "grok-benchmark", grokTs, path.join(archiveRoot,"grok/benchmark/synthetic-grok.jsonl"), 1000, 200, 30, 100, 17,
              subject, `repo-${subject}`, "synthetic", 7_000_000);
          }
          for (const store of ["glm-original", "glm-copy"]) {
            glmInsert.run(store, glmIdentity, glmIdentity, glmTs, "glm-benchmark", "zai-coding-plan",
              subject, `repo-${subject}`, "synthetic", 900, 80, 40, 100, 20, 0.009);
          }
        }
      }
    })();
    grokInsert.finalize();
    glmInsert.finalize();

    const preparationStarted = performance.now();
    const preparationCalls = prepare(db, [["grok", GROK_ACCOUNT], ["glm", GLM_ACCOUNT]]);
    const preparationMs = round3(performance.now() - preparationStarted);
    // Project cost also reads Claude's (empty) usage ledger, which must be ready.
    fillUsageLedger(db, "claude", rates, archiveRoot, 500);
    const expected = baseExpected();

    const firstRead = sample(db);
    assertExpected(firstRead.value, expected);

    const repeated = collectSamples(db);
    for (const read of repeated.reads) assertExpected(read.value, expected);

    const glmBeforeCorrections = JSON.stringify(firstRead.value.providers.glm);
    const lateIdentity = "grok-late-alpha";
    const lateTs = `${UNTIL}T20:00:00.000Z`;
    const lateInsert = db.query(`INSERT INTO grok_events(
      store,source_id,session_id,prompt_id,model,ts,path,in_tok,cached_in,cache_write,
      out_tok,reasoning,project_id,repo,repo_group,cost_ticks)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    db.transaction(() => {
      lateInsert.run("grok-original", "original-grok-late-alpha", lateIdentity, lateIdentity,
        "grok-benchmark", lateTs, path.join(archiveRoot,"grok/benchmark/synthetic-grok-late.jsonl"), 1_001_000, 200, 30, 100, 17,
        "alpha", "repo-alpha", "synthetic", 17_000_000);
      lateInsert.run("grok-copy", "replica-grok-late-alpha", lateIdentity, lateIdentity,
        "grok-benchmark", lateTs, path.join(archiveRoot,"grok/benchmark/synthetic-grok-late.jsonl"), 1_001_000, 200, 30, 100, 17,
        "alpha", "repo-alpha", "synthetic", 17_000_000);
    })();
    lateInsert.finalize();
    const latePreparation = prepare(db, [["grok", GROK_ACCOUNT]]);
    expected.grok.calls += 1;
    expected.grok.tokens += LATE_GROK_EVENT.tokens;
    expected.grok.apiUsd += LATE_GROK_EVENT.apiUsd;
    expected.grok.reportedUsd += LATE_GROK_EVENT.reportedUsd;
    expected.subjects.alpha!.calls += 1;
    expected.subjects.alpha!.tokens += LATE_GROK_EVENT.tokens;
    expected.subjects.alpha!.grokTokens += LATE_GROK_EVENT.tokens;
    expected.subjects.alpha!.grokApiUsd += LATE_GROK_EVENT.apiUsd;
    const afterLateEvent = sample(db);
    assertExpected(afterLateEvent.value, expected);
    assert.equal(JSON.stringify(afterLateEvent.value.providers.glm), glmBeforeCorrections,
      "The unrelated GLM account must remain unchanged");

    db.query("UPDATE grok_events SET in_tok=2000 WHERE prompt_id=?").run("grok-0-beta");
    const correctionPreparation = prepare(db, [["grok", GROK_ACCOUNT]]);
    expected.grok.tokens += TOKEN_CORRECTION.tokens;
    expected.grok.apiUsd += TOKEN_CORRECTION.apiUsd;
    expected.subjects.beta!.tokens += TOKEN_CORRECTION.tokens;
    expected.subjects.beta!.grokTokens += TOKEN_CORRECTION.tokens;
    expected.subjects.beta!.grokApiUsd += TOKEN_CORRECTION.apiUsd;
    const afterTokenCorrection = sample(db);
    assertExpected(afterTokenCorrection.value, expected);
    assert.equal(JSON.stringify(afterTokenCorrection.value.providers.glm), glmBeforeCorrections,
      "The unrelated GLM account must remain unchanged after correction");

    const noOpRepeat = sample(db);
    assertExpected(noOpRepeat.value, expected);
    assert.deepEqual(noOpRepeat.value, afterTokenCorrection.value);

    db.close(true);
    const restartStarted = performance.now();
    const child = Bun.spawn([
      process.execPath,
      import.meta.path,
      "--restart-child",
      created.dbPath,
      sandbox,
    ], { stdout: "pipe", stderr: "inherit" });
    const childOutput = await new Response(child.stdout).text();
    assert.equal(await child.exited, 0, "Restart benchmark failed");
    const restartProcessMs = round3(performance.now() - restartStarted);
    const restarted = JSON.parse(childOutput.trim().split(/\r?\n/).filter(Boolean).at(-1)!) as {
      summary: ReturnType<typeof distribution>;
      reference: ConsumerSnapshot;
    };
    assert.deepEqual(restarted.reference, noOpRepeat.value);

    const report = {
      kind: "synthetic-provider-consumers-two-year-read",
      generated_at: new Date().toISOString(),
      production_data_used: false,
      period: PERIOD,
      days: DAYS,
      subjects: [...SUBJECTS],
      providers: ["grok", "glm"],
      accounts: [GROK_ACCOUNT, GLM_ACCOUNT],
      canonical_calls_initial: DAYS * SUBJECTS.length * 2,
      physical_replicas_per_call: 2,
      physical_rows_initial: DAYS * SUBJECTS.length * 2 * 2,
      independent_event_expectations: { grok: GROK_EVENT, glm: GLM_EVENT },
      fact_preparation_ms: preparationMs,
      fact_preparation_calls: preparationCalls,
      first_read: {
        ms: firstRead.ms,
        raw_or_fact_queries: firstRead.raw_or_fact_queries,
        value: firstRead.value,
      },
      repeated_reads: repeated.summary,
      corrections: {
        late_event: {
          fact_preparation_calls: latePreparation,
          ms: afterLateEvent.ms,
          raw_or_fact_queries: afterLateEvent.raw_or_fact_queries,
          value: afterLateEvent.value,
        },
        token_correction: {
          fact_preparation_calls: correctionPreparation,
          ms: afterTokenCorrection.ms,
          raw_or_fact_queries: afterTokenCorrection.raw_or_fact_queries,
          value: afterTokenCorrection.value,
        },
        no_op_repeat: {
          ms: noOpRepeat.ms,
          raw_or_fact_queries: noOpRepeat.raw_or_fact_queries,
        },
      },
      restarted_process_reads: restarted.summary,
      restarted_process_total_ms: restartProcessMs,
      final_expected: expected,
      limitations: [
        "Synthetic 730-day workload with two canonical calls per provider/day and two physical replicas per call; not production data.",
        "CPU timings intentionally have no pass/fail latency threshold and reuse the operating system filesystem cache.",
        "Repeated timing begins after the first read; restart timing samples begin after module loading and database open inside the child.",
        "Measures backend project cost, repository history, and selector composition; excludes HTTP, desktop rendering, and concurrent import.",
      ],
    };
    const resolvedOutput = path.resolve(outputPath!);
    fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
    fs.writeFileSync(resolvedOutput, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    try { db.close(true); } catch { }
    Bun.gc(true);
    fs.rmSync(created.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
