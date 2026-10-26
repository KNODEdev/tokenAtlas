import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "./sqlite";
import {
  ensureWindowAnswersSchema, foldWindowAnswerMarks, MARK_FOLD_AGE_MS, markWindowAnswersDirty, readFamilyAnswer, readWindowAnswer,
  storeWindowAnswers, windowAnswerIsCurrent, windowAnswerMarkSeq, type WindowAnswer,
} from "./window-answers";
import { markWindowUsageDirty, markWindowUsageRangesDirty } from "./window-usage";

const opened: Array<{ db: Database; dir: string }> = [];
afterEach(() => {
  for (const { db, dir } of opened.splice(0)) { db.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});
function database() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "window-answers-")), file = path.join(dir, "atlas.sqlite");
  const db = new Database(file);
  ensureWindowAnswersSchema(db);
  opened.push({ db, dir });
  return { db, file };
}
const DAY = 86_400_000, WEEK = 7 * DAY;
const W1 = Date.parse("2026-09-01T00:00:00.000Z"), W2 = W1 + WEEK, W3 = W2 + WEEK;
function answer(db: Database, patch: Partial<WindowAnswer> & { key: string; from: number; until: number }): WindowAnswer {
  const { from, until, ...rest } = patch;
  return { route: "/api/cycle-breakdown", family: `family:${patch.key}`, scope: { provider: "codex", account: "codex1", fromMs: from, untilMs: until },
    configuration: "c1", checked: windowAnswerMarkSeq(db), builtAt: Date.now(), expiresAt: null, status: 200, version: "v1", headers: [],
    body: JSON.stringify({ key: patch.key }), ...rest };
}
const current = (db: Database, key: string) => windowAnswerIsCurrent(db, readWindowAnswer(db, "/api/cycle-breakdown", key)!, "c1");

test("a stored answer stays current until a mark inside its scope; other providers, accounts and instants never touch it", () => {
  const { db, file } = database();
  storeWindowAnswers(db, [answer(db, { key: "w1", from: W1, until: W2 }), answer(db, { key: "w2", from: W2, until: W3 })]);
  expect(current(db, "w1") && current(db, "w2")).toBe(true);
  // Another provider, another account, and new calls after both windows.
  markWindowUsageRangesDirty(db, "claude", [[W1, W3]]);
  markWindowUsageDirty(db, { provider: "codex", account: "codex2", fromMs: W1, untilMs: W3 });
  markWindowUsageRangesDirty(db, "codex", [[W3 + DAY, W3 + DAY + 3_600_000]]);
  expect(current(db, "w1") && current(db, "w2")).toBe(true);
  // A late call in the second week (the ledger marks its hour for every account): only that window is stale.
  markWindowUsageRangesDirty(db, "codex", [[W2 + DAY, W2 + DAY + 3_600_000]]);
  expect(current(db, "w1")).toBe(true);
  expect(current(db, "w2")).toBe(false);
  // A period change of the account from the first week on: both.
  markWindowUsageDirty(db, { provider: "codex", account: "CODEX1", fromMs: W1 + DAY });
  expect(current(db, "w1")).toBe(false);
  // A restart reads the same rows and the same verdicts.
  const again = new Database(file);
  try {
    expect(windowAnswerIsCurrent(again, readWindowAnswer(again, "/api/cycle-breakdown", "w1")!, "c1")).toBe(false);
    expect(JSON.parse(readWindowAnswer(again, "/api/cycle-breakdown", "w1")!.body)).toEqual({ key: "w1" });
  } finally { again.close(); }
});

test("a recomputed answer replaces the stale one; an answer read from an older snapshot never replaces a newer one", () => {
  const { db } = database();
  const old = answer(db, { key: "w1", from: W1, until: W2 });
  storeWindowAnswers(db, [old]);
  markWindowUsageDirty(db, { provider: "codex", account: "codex1", fromMs: W1, untilMs: W2 });
  const fresh = answer(db, { key: "w1", from: W1, until: W2, body: JSON.stringify({ key: "w1", events: 2 }) });
  expect(fresh.checked).toBeGreaterThan(old.checked);
  storeWindowAnswers(db, [fresh]);
  expect(current(db, "w1")).toBe(true);
  storeWindowAnswers(db, [{ ...old, builtAt: Date.now() + 1000 }]);
  expect(JSON.parse(readWindowAnswer(db, "/api/cycle-breakdown", "w1")!.body)).toEqual({ key: "w1", events: 2 });
  expect(current(db, "w1")).toBe(true);
});

test("the configuration and the clock make an answer stale; a family answers for a request seen first", () => {
  const { db } = database();
  storeWindowAnswers(db, [answer(db, { key: "w1", from: W1, until: W2, family: "paired", expiresAt: Date.now() + 60_000 }),
    answer(db, { key: "w1b", from: W1, until: W2 + 1, family: "paired", builtAt: Date.now() + 1 })]);
  const stored = readWindowAnswer(db, "/api/cycle-breakdown", "w1")!;
  expect(windowAnswerIsCurrent(db, stored, "c2")).toBe(false);
  expect(windowAnswerIsCurrent(db, stored, "c1", Date.now() + 120_000)).toBe(false);
  expect(readFamilyAnswer(db, "/api/cycle-breakdown", "paired")!.key).toBe("w1b");
  expect(readFamilyAnswer(db, "/api/cycle-breakdown", "other")).toBeNull();
});

test("old marks fold into the answers they overlap, and an answer from before the fold is stored stale", () => {
  const { db } = database();
  const before = answer(db, { key: "w1", from: W1, until: W2 });
  storeWindowAnswers(db, [before, answer(db, { key: "w3", from: W3, until: W3 + WEEK })]);
  markWindowUsageRangesDirty(db, "codex", [[W1 + DAY, W1 + DAY + 3_600_000]]);
  const later = Date.now() + MARK_FOLD_AGE_MS + 1;
  expect(foldWindowAnswerMarks(db, later)).toBe(false);
  expect(db.query("SELECT COUNT(*) n FROM window_answer_marks").get()).toEqual({ n: 0 });
  expect(current(db, "w1")).toBe(false);
  expect(current(db, "w3")).toBe(true);
  // An answer computed before the folded mark (published late) cannot prove it saw it.
  storeWindowAnswers(db, [{ ...answer(db, { key: "w2", from: W2, until: W3 }), checked: before.checked }]);
  expect(current(db, "w2")).toBe(false);
  // The high-water mark survives the fold: a new answer is current.
  storeWindowAnswers(db, [answer(db, { key: "w2", from: W2, until: W3 })]);
  expect(current(db, "w2")).toBe(true);
});

test("marks are written in the writer's transaction, so a rolled-back change leaves the answers current", () => {
  const { db } = database();
  storeWindowAnswers(db, [answer(db, { key: "w1", from: W1, until: W2 })]);
  expect(() => db.transaction(() => {
    markWindowAnswersDirty(db, { provider: "codex", account: "codex1", fromMs: W1, untilMs: W2 });
    throw new Error("writer failed");
  })()).toThrow("writer failed");
  expect(current(db, "w1")).toBe(true);
});
