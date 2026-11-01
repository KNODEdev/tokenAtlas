import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeTestFixture } from "../test-cleanup";
import { DEFAULT_CLOUD_SYNC_MINUTES, readCloudSyncSetting, saveCloudSyncMinutes } from "./claude-cloud-settings";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTestFixture(root, { recursive: true, force: true }); });
const root = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-cloud-setting-")); roots.push(dir); return dir; };

describe("cloud session interval", () => {
  test("defaults to 30 minutes, keeps a saved choice and lets the environment override an enabled one", () => {
    const dir = root();
    expect(readCloudSyncSetting({}, dir)).toEqual({ minutes: DEFAULT_CLOUD_SYNC_MINUTES, source: "default" });
    expect(readCloudSyncSetting({ TOKENATLAS_CLOUD_MINUTES: "15" }, dir)).toEqual({ minutes: 15, source: "environment" });
    expect(saveCloudSyncMinutes(60, dir)).toEqual({ minutes: 60, source: "settings" });
    expect(readCloudSyncSetting({}, dir)).toEqual({ minutes: 60, source: "settings" });
    expect(readCloudSyncSetting({ TOKENATLAS_CLOUD_MINUTES: "15" }, dir)).toEqual({ minutes: 15, source: "environment" });
    expect(readCloudSyncSetting({ TOKENATLAS_CLOUD_MINUTES: "0" }, dir).minutes).toBe(0);
  });
  test("a saved off is a veto the environment cannot lift", () => {
    const dir = root();
    expect(saveCloudSyncMinutes(0, dir).minutes).toBe(0);
    expect(readCloudSyncSetting({ TOKENATLAS_CLOUD_MINUTES: "15" }, dir)).toEqual({ minutes: 0, source: "settings" });
  });
  test("refuses anything but whole minutes within a day", () => {
    const dir = root();
    for (const value of [-1, 1.5, 1441, "30", null]) expect(() => saveCloudSyncMinutes(value, dir)).toThrow("whole number");
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
