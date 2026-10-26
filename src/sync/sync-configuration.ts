import type { ConfigDomain, SyncRunResult, VendorId } from "./contracts";
import { createHash } from "node:crypto";
import { configFile } from "../config/paths";
import fs from "node:fs";
import { CONFIG_DOMAINS } from "./contracts";
import type { ConfigSnapshot } from "./coordinator-contracts";
import type { Database } from "../db/sqlite";
import { storedFingerprint, rulesFingerprint, remap, loadProjects } from "../projects/remap";
import type { DeltaIdentity } from "./vendor-publication-schema";

const CONFIG_FILES = [
  "accounts.json",
  "rate-cards.json",
  "projects.json",
  "cycles.json",
  "plans.json",
  "plans-catalog.json",
  "claude-gauge.json",
  "grok-gauge.json",
] as const;

const CONFIG_DOMAIN_FILES: Record<ConfigDomain, (typeof CONFIG_FILES)[number]> = {
  accounts: "accounts.json",
  "rate-cards": "rate-cards.json",
  projects: "projects.json",
  cycles: "cycles.json",
  plans: "plans.json",
  "plans-catalog": "plans-catalog.json",
  "claude-gauge": "claude-gauge.json",
  "grok-gauge": "grok-gauge.json",
};

function fileFingerprint(name: string): string {
  const hash = createHash("sha256");
  const file = configFile(name);
  hash.update(name);
  hash.update("\0");
  if (fs.existsSync(file)) hash.update(fs.readFileSync(file));
  else hash.update("<missing>");
  return hash.digest("hex");
}

export function configurationFingerprints(): ConfigSnapshot {
  const domains = Object.fromEntries(
    CONFIG_DOMAINS.map((domain) => [domain, fileFingerprint(CONFIG_DOMAIN_FILES[domain])])
  ) as Record<ConfigDomain, string>;
  const hash = createHash("sha256");
  for (const name of CONFIG_FILES) {
    hash.update(name);
    hash.update("\0");
    const file = configFile(name);
    if (fs.existsSync(file)) hash.update(fs.readFileSync(file));
    else hash.update("<missing>");
    hash.update("\0");
  }
  return { fingerprint: hash.digest("hex"), domains };
}

export function refreshDerivedState(
  sqlite: Database,
  _result: SyncRunResult,
  changedDomains: ConfigDomain[],
  _affected: ReadonlyMap<VendorId, DeltaIdentity[]>,
  progress: (phase: "attribution" | "projects") => void,
): void {
  for (const domain of changedDomains) {
    const file = configFile(CONFIG_DOMAIN_FILES[domain]);
    if (fs.existsSync(file)) JSON.parse(fs.readFileSync(file, "utf8"));
  }
  // No row carries an account to write: periods resolve Codex and Claude rows at read time
  // (stage 4, W4/W6). The phase stays in the progress contract the sync screen shows.
  progress("attribution");
  progress("projects");
  // Project assignment does not depend on accounts (docs/account-periods-model-2026-09-21.md §4).
  // Rows already mapped under the current rules (a first import's stages) are not mapped again.
  // Usage sums follow the published facts in the ledgers' background producers (plan U4.1).
  if (changedDomains.includes("projects") && storedFingerprint(sqlite) !== rulesFingerprint()) remap(sqlite, loadProjects());
}
