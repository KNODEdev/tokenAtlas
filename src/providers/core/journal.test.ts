import { expandProbeJournal } from "./journal-compact";
import { dailyJournalFile } from "./journal-files";
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "../../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LOGIN, MACHINE } from "../../config/paths";
import { applyDrizzleMigrations } from "../../db/migrate";
import * as schema from "../../db/schema";
import { configureGaugeJournal, gaugeJournalRoot, pendingGaugeJournalLines, flushGaugeJournal } from "./journal";

import { persistProbeWindows } from "./probe";
import type { WindowReading } from "../types";

const tempDirectories: string[] = [];

afterEach(() => configureGaugeJournal(null));
afterAll(() => {
  for (const directory of tempDirectories.splice(0)) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // Bun can retain a Windows SQLite handle until process teardown.
    }
  }
});

function fixture(): { sqlite: Database; journalRoot: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-journal-"));
  tempDirectories.push(directory);
  const sqlite = new Database(path.join(directory, "atlas.sqlite"), { create: true });
  applyDrizzleMigrations(drizzle(sqlite, { schema }));
  return { sqlite, journalRoot: path.join(directory, "gauges", `${MACHINE}-${LOGIN}`) };
}

function reading(overrides: Partial<WindowReading> = {}): WindowReading {
  return {
    kind: "primary",
    group: "codex",
    scope: null,
    plan: "plus",
    reportedPercentSide: "used",
    usedPercent: 42,
    remainingPercent: null,
    allowance: null,
    used: null,
    remaining: null,
    vendorPercent: 42,
    windowMinutes: 300,
    resetsAt: "2026-09-02T14:00:00.000Z",
    rateLimitReached: false,
    resetCredits: null,
    profile: null,
    ok: null,
    error: null,
    extra: { home: "C:/Users/sample_a/.codex" },
    ...overrides,
  };
}

describe("gauge journal", () => {
  test("is off until configured: samples land in the table, nothing on disk", () => {
    const { sqlite, journalRoot } = fixture();
    try {
      expect(gaugeJournalRoot()).toBeNull();
      expect(persistProbeWindows(sqlite, "codex", "codex1", "2026-09-02T10:00:00.000Z", [reading()])).toBe(1);
      expect(fs.existsSync(journalRoot)).toBe(false);
      const row = sqlite.query("SELECT machine FROM probe_windows").get() as { machine: string };
      expect(row.machine).toBe(MACHINE);
    } finally {
      sqlite.close();
    }
  });

  test("appends one line per sample with machine, login, source home and raw subject", () => {
    const { sqlite, journalRoot } = fixture();
    configureGaugeJournal(journalRoot);
    try {
      persistProbeWindows(sqlite, "codex", "codex1", "2026-09-02T10:00:00.000Z", [
        reading(),
        reading({ kind: "secondary", windowMinutes: 10_080 }),
      ]);
      persistProbeWindows(sqlite, "claude", "claude", "2026-09-02T10:01:00.000Z", [reading({ group: null, extra: null })]);
      flushGaugeJournal(sqlite, { journalRoot, archiveRoot: null });
      const lines = expandProbeJournal(fs
        .readFileSync(path.join(journalRoot, dailyJournalFile("probe_windows.jsonl", new Date())), "utf8")
        .trim()
        .split("\n"));
      expect(lines).toHaveLength(3);
      expect(lines[0]).toMatchObject({
        provider: "codex",
        subject: "codex1",
        raw_subject: "codex1",
        ts: "2026-09-02T10:00:00.000Z",
        kind: "primary",
        used_percent: 42,
        rate_limit_reached: 0,
        machine: MACHINE,
        login: LOGIN,
        source_home: "C:/Users/sample_a/.codex",
        extra: JSON.stringify({ home: "C:/Users/sample_a/.codex" }),
      });
      expect(lines[2]).toMatchObject({ provider: "claude", source_home: null, extra: null });
    } finally {
      sqlite.close();
    }
  });

  test("lines that could not be appended are retried in front of the next append", () => {
    const { sqlite, journalRoot } = fixture();
    // Archive root "missing": the append must fail without losing the lines.
    configureGaugeJournal(journalRoot, { archiveRoot: path.join(journalRoot, "..", "..", "not-mounted") });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      persistProbeWindows(sqlite, "codex", "codex1", "2026-09-02T10:00:00.000Z", [reading()]);
      expect(fs.existsSync(path.join(journalRoot, dailyJournalFile("probe_windows.jsonl", new Date())))).toBe(false);
      expect(pendingGaugeJournalLines(sqlite)).toBe(1);
      // Archive back: the next append flushes the pending line first, in order.
      configureGaugeJournal(journalRoot, { archiveRoot: path.join(journalRoot, "..", "..", "not-mounted") });
      fs.mkdirSync(path.join(journalRoot, "..", "..", "not-mounted"));
      persistProbeWindows(sqlite, "codex", "codex1", "2026-09-02T10:05:00.000Z", [reading()]);
      flushGaugeJournal(sqlite, { journalRoot, archiveRoot: path.join(journalRoot, "..", "..", "not-mounted") });
      const lines = fs.readFileSync(path.join(journalRoot, dailyJournalFile("probe_windows.jsonl", new Date())), "utf8").trim().split("\n");
      expect(expandProbeJournal(lines).map(line => line.ts)).toEqual([
        "2026-09-02T10:00:00.000Z",
        "2026-09-02T10:05:00.000Z",
      ]);
      expect(pendingGaugeJournalLines(sqlite)).toBe(0);
    } finally {
      warn.mockRestore();
      sqlite.close();
    }
  });
});
