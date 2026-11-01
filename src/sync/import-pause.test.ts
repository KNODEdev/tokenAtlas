import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeTestFixture } from "../test-cleanup";
import { importPaused, saveImportPaused } from "./import-pause";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTestFixture(root, { recursive: true, force: true }); });
const root = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-import-pause-state-")); roots.push(dir); return dir; };

// TALK-001 D12 (REQ-064 AC5): a paused import stays paused until Resume; only a missing file means "running".
describe("import pause state", () => {
  test("is off without a file, kept once paused and cleared by Resume", () => {
    const dir = root();
    expect(importPaused(dir)).toBe(false);
    saveImportPaused(true, dir);
    expect(importPaused(dir)).toBe(true);
    saveImportPaused(false, dir);
    expect(importPaused(dir)).toBe(false);
  });
  test("a damaged or unreadable file keeps the import stopped", () => {
    const dir = root();
    fs.writeFileSync(path.join(dir, "import-paused.json"), "{");
    expect(importPaused(dir)).toBe(true);
    fs.writeFileSync(path.join(dir, "import-paused.json"), JSON.stringify({ schema: 2, paused: false }));
    expect(importPaused(dir)).toBe(true);
    fs.rmSync(path.join(dir, "import-paused.json"));
    fs.mkdirSync(path.join(dir, "import-paused.json"));
    expect(importPaused(dir)).toBe(true);
  });
});
