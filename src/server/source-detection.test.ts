import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanVendorProfiles } from "../providers/vendor-identity";
import { scanCodexProfiles } from "../providers/codex-identity";

test("discovery retains every sibling profile and limits choices to the selected provider", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-discover-"));
  try {
    for (const prefix of [".codex", ".claude", ".grok", ".gemini"]) for (const suffix of ["", "-work", "-other"]) fs.mkdirSync(path.join(root, prefix + suffix));
    fs.writeFileSync(path.join(root, ".gemini-work", "google_accounts.json"), JSON.stringify({ active: "work@example.test" }));
    fs.writeFileSync(path.join(root, ".claude-work", ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "claude@example.test", accountUuid: "fixture" } }));
    const options = { home: root, machine: "TEST", platform: "linux", pool: [{ id: "agy1", profile: "worker1", port: 9999, google: "account_0000@example.test" }] };
    expect(scanCodexProfiles(options).filter(profile => profile.home.startsWith(root))).toHaveLength(3);
    for (const vendor of ["claude", "grok", "gemini"] as const) {
      const profiles = scanVendorProfiles({ ...options, vendor });
      expect(profiles.every(profile => profile.vendor === vendor)).toBe(true);
      expect(profiles.filter(profile => profile.home.startsWith(root))).toHaveLength(3);
      if (vendor === "gemini") {
        expect(profiles.find(profile => profile.home === "pool:agy1")).toMatchObject({ surface: "antigravity", email: "account_0000@example.test" });
        expect(profiles.find(profile => profile.home === path.join(root, ".gemini-work"))?.email).toBe("work@example.test");
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
