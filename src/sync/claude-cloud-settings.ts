import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { localStateRoot } from "../config/local-identity";

/**
 * How often this computer reads Claude cloud sessions (user decision 23.10.2026: 30 minutes by default,
 * changeable in Settings; 0 turns the source off). Machine-local: the computer that syncs writes its own
 * `-cloud` archive folders. `TOKENATLAS_CLOUD_MINUTES` overrides the stored choice, like the other cycles.
 */
export const DEFAULT_CLOUD_SYNC_MINUTES = 30;
const MAX_MINUTES = 24 * 60;
const FILE = "claude-cloud-settings.json";

export interface CloudSyncSetting { minutes: number; source: "environment" | "settings" | "default" }

export function validCloudSyncMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_MINUTES)
    throw new Error(`Cloud session interval must be a whole number of minutes from 0 to ${MAX_MINUTES}.`);
  return value;
}

export function readCloudSyncSetting(env: NodeJS.ProcessEnv = process.env, root = localStateRoot(env)): CloudSyncSetting {
  const override = env.TOKENATLAS_CLOUD_MINUTES?.trim();
  if (override) return { minutes: validCloudSyncMinutes(Number(override)), source: "environment" };
  const file = path.join(root, FILE);
  if (!fs.existsSync(file)) return { minutes: DEFAULT_CLOUD_SYNC_MINUTES, source: "default" };
  const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { schema?: unknown; minutes?: unknown };
  if (stored.schema !== 1) throw new Error("Invalid local cloud session setting.");
  return { minutes: validCloudSyncMinutes(stored.minutes), source: "settings" };
}

export function saveCloudSyncMinutes(minutes: unknown, root = localStateRoot()): CloudSyncSetting {
  const value = validCloudSyncMinutes(minutes);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, FILE), candidate = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(candidate, JSON.stringify({ schema: 1, minutes: value }) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(candidate, file);
  } finally { fs.rmSync(candidate, { force: true }); }
  return { minutes: value, source: "settings" };
}
