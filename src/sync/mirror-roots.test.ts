import { describe, expect, test } from "bun:test";
import path from "node:path";
import { ATLAS_INDEX_SNAPSHOT_DIRECTORY, HOME_DIR, LOGIN, MACHINE } from "../config/paths";
import { isOwnArchiveDestination, vendorLocalSourceRoots } from "./mirror";

const profiles = [{ login: LOGIN, home: HOME_DIR }, { login: "other", home: "C:/Users/other" }];

describe("vendorLocalSourceRoots", () => {
  test("fingerprints only what the mirror copies", () => {
    const opencode = vendorLocalSourceRoots("opencode", profiles);
    expect(opencode).toEqual([
      path.join(HOME_DIR, ".local", "share", "opencode", "opencode.db"),
      path.join(HOME_DIR, ".local", "share", "opencode", "opencode.db-wal"),
    ]);
    const gemini = vendorLocalSourceRoots("gemini", profiles, []);
    expect(gemini.every((root) => /conversations$|history\.jsonl$/.test(root))).toBe(true);
    expect(gemini.some((root) => root.endsWith(path.join("antigravity-cli")))).toBe(false);
    expect(vendorLocalSourceRoots("codex", profiles, [])).toHaveLength(5);
    expect(vendorLocalSourceRoots("codex", profiles, [])).toContain(path.join(HOME_DIR, ".codex", "archived_sessions"));
    expect(vendorLocalSourceRoots("gauges", profiles)).toEqual([]);
  });
});

describe("isOwnArchiveDestination", () => {
  const root = "C:/archive";
  test("this machine's mirrors, ledger and gauge journal are its own", () => {
    expect(isOwnArchiveDestination(path.join(root, "codex", `${MACHINE}-${LOGIN}`, "sessions", "a.jsonl"), root)).toBe(true);
    expect(isOwnArchiveDestination(path.join(root, "codex", `${MACHINE}-other`, "sessions"), root)).toBe(true);
    expect(isOwnArchiveDestination(path.join(root, "codex", "_ledger", "delegate-ledger.jsonl"), root)).toBe(true);
    expect(isOwnArchiveDestination(path.join(root, "claude", MACHINE, "x.jsonl"), root)).toBe(true);
    expect(isOwnArchiveDestination(path.join(root, "claude", `${MACHINE}-desktop`), root)).toBe(true);
    expect(isOwnArchiveDestination(path.join(root, "opencode", MACHINE, "opencode.sqlite"), root)).toBe(true);
    expect(isOwnArchiveDestination(path.join(root, "gauges", `${MACHINE}-${LOGIN}`, "probe_windows.jsonl"), root)).toBe(true);
    expect(isOwnArchiveDestination(path.join(root, ATLAS_INDEX_SNAPSHOT_DIRECTORY, "orphan.atlas.sqlite.tmp-1-id"), root)).toBe(true);
  });
  test("other machines' subtrees, the config and the root itself are not", () => {
    expect(isOwnArchiveDestination(path.join(root, "codex", "OTHER-PC-sample_a", "sessions"), root)).toBe(false);
    expect(isOwnArchiveDestination(path.join(root, "gauges", "OTHER-PC-sample_a", "probe_windows.jsonl"), root)).toBe(false);
    expect(isOwnArchiveDestination(path.join(root, "claude", `${MACHINE}x`), root)).toBe(false);
    expect(isOwnArchiveDestination(path.join(root, "config", "accounts.json"), root)).toBe(false);
    expect(isOwnArchiveDestination(root, root)).toBe(false);
    expect(isOwnArchiveDestination(null, root)).toBe(false);
    expect(isOwnArchiveDestination("C:/elsewhere/codex/" + MACHINE + "-x", root)).toBe(false);
  });
});

test("Grok and Gemini changed profiles feed both the mirror and its change detector", async () => {
  const { profileMirrorTargets } = await import("./mirror");
  const { archive } = await import("../config/paths");
  for (const vendor of ["grok", "gemini"] as const) {
    const profile = path.join(HOME_DIR, `.${vendor}-work`), destination = archive(vendor, `${MACHINE}-${LOGIN}`);
    const declarations = [
      { vendor, machine: MACHINE, source_home: profile, home: destination },
      { vendor, machine: "REMOTE", source_home: "C:/remote/profile", home: "C:/remote/archive" },
      { vendor, machine: MACHINE, source_home: "C:/old/profile", home: "C:/old/archive" },
    ];
    const targets = profileMirrorTargets(vendor, [{ login: LOGIN, home: HOME_DIR }], declarations);
    expect(targets).toEqual([{ source: path.join(profile, vendor === "grok" ? "sessions" : "antigravity-cli/conversations"),
      destination: path.join(destination, vendor === "grok" ? "sessions" : "conversations") },
      { source: path.join(path.resolve("C:/old/profile"), vendor === "grok" ? "sessions" : "antigravity-cli/conversations"),
        destination: path.join(path.resolve("C:/old/archive"), vendor === "grok" ? "sessions" : "conversations") }]);
    const roots = vendorLocalSourceRoots(vendor, [{ login: LOGIN, home: HOME_DIR }], declarations);
    expect(roots).toContain(targets[0]!.source);
    expect(roots.some(root => root.includes(`.${vendor}${path.sep}`))).toBe(false);
    if (vendor === "gemini") expect(roots).toContain(path.join(profile, "antigravity-cli", "history.jsonl"));
  }
});
