import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { scanCodexProfiles } from "../providers/codex-identity";
import { scanVendorProfiles } from "../providers/vendor-identity";
import type { SourceDetectedProfile, SourceProfileConfiguration } from "../shared/source-health";

export function detectSourceProfiles(vendor: string, config: SourceProfileConfiguration): SourceDetectedProfile[] {
  const homes = config.declarations.flatMap((row, i) => (row.vendor ?? "codex") === vendor && row.machine?.toLowerCase() === config.machine.toLowerCase() && config.resolved[i]?.profile ? [config.resolved[i]!.profile!] : []);
  if (vendor === "codex") return scanCodexProfiles({ machine: config.machine, declaredHomes: homes }).map(profile => ({
    vendor, home: profile.home, name: path.basename(profile.home), account: profile.identity?.email ?? null, kind: "folder", error: profile.error,
  }));
  if (["claude", "grok", "gemini"].includes(vendor)) return scanVendorProfiles({ machine: config.machine, vendor: vendor as "claude" | "grok" | "gemini",
    declaredHomes: homes.map(home => ({ vendor: vendor as "claude" | "grok" | "gemini", home })) }).filter(profile => profile.vendor === vendor).map(profile => ({
      vendor, home: profile.home, name: profile.worker?.profile ?? path.basename(profile.home), account: profile.email,
      kind: profile.surface === "antigravity" ? "managed" : "folder", error: profile.error,
    }));
  if (vendor === "opencode") {
    const home = path.join(os.homedir(), ".local", "share", "opencode");
    return fs.existsSync(home) ? [{ vendor, home, name: "OpenCode", account: null, kind: "folder", error: null }] : [];
  }
  return [];
}
