import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeTestFixture } from "../test-cleanup";
import { limitReadingsEnabled, readLimitReadingsSetting, saveLimitReadingsEnabled } from "./limit-readings-settings";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTestFixture(root, { recursive: true, force: true }); });
const root = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-readings-setting-")); roots.push(dir); return dir; };

describe("limit readings setting", () => {
  test("is on by default and keeps a saved choice", () => {
    const dir = root();
    expect(readLimitReadingsSetting(dir)).toEqual({ enabled: true, source: "default" });
    expect(saveLimitReadingsEnabled(false, dir)).toEqual({ enabled: false, source: "settings" });
    expect(limitReadingsEnabled(dir)).toBe(false);
    saveLimitReadingsEnabled(true, dir);
    expect(readLimitReadingsSetting(dir)).toEqual({ enabled: true, source: "settings" });
  });
  test("refuses anything but on or off, and reads a damaged file as off", () => {
    const dir = root();
    for (const value of ["true", 1, null]) expect(() => saveLimitReadingsEnabled(value, dir)).toThrow("on or off");
    expect(fs.readdirSync(dir)).toEqual([]);
    fs.writeFileSync(path.join(dir, "limit-readings-settings.json"), "{");
    expect(limitReadingsEnabled(dir)).toBe(false);
  });
});
