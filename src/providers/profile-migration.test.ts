import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanCodexProfiles } from "./codex-identity";
import { scanVendorProfiles } from "./vendor-identity";
import { profileMirrorTargets, vendorLocalSourceRoots } from "../sync/mirror";
import { HOME_DIR, MACHINE, LOGIN } from "../config/paths";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-profile-move-")); dirs.push(root); return root; }
function write(root: string, name: string, value: unknown) { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); }
test("prefix discovery finds suffixes, deduplicates explicit paths and ignores matching files", () => {
  const root = fixture();
  const auth = { tokens: { account_id: "mr", access_token: "SECRET", id_token: "h." + Buffer.from(JSON.stringify({ email: "mr@example.com" })).toString("base64url") + ".s" } };
  for (const name of [".codex", ".codex-mr", ".codexxxxx"]) write(root, name + "/auth.json", auth);
  write(root, ".codex-backup.json", {});
  const profiles = scanCodexProfiles({ home: root, platform: "linux", codexHome: path.join(root, ".codex-mr") });
  expect(profiles.map(p => path.basename(p.home)).sort()).toEqual([".codex", ".codex-mr", ".codexxxxx"]);
  expect(profiles.every(p => p.identity?.email === "mr@example.com")).toBe(true);
  expect(JSON.stringify(profiles)).not.toContain("SECRET");
  write(root, ".claudexxx/.claude.json", { oauthAccount: { emailAddress: "mr@example.com", accountUuid: "mr" } });
  write(root, ".claudexxx/.credentials.json", { claudeAiOauth: { accessToken: "SECRET", subscriptionType: "pro" } });
  write(root, ".claude-backup.json", {});
  const claude = scanVendorProfiles({ home: root, platform: "linux", pool: [] });
  expect(claude).toHaveLength(1); expect(claude[0]?.email).toBe("mr@example.com");
  expect(JSON.stringify(claude)).not.toContain("SECRET");
});
test("moved profiles replace the old archive writer and participate in change detection", () => {
  const profiles = [{ login: LOGIN, home: HOME_DIR }];
  const baseline = profileMirrorTargets("codex", profiles, []);
  const source = path.join(HOME_DIR, ".codex-mr"), home = path.dirname(baseline[0]!.destination);
  const declarations = [{ vendor: "codex", machine: MACHINE, source_home: source, home }];
  expect(profileMirrorTargets("codex", profiles, declarations)).toEqual([
    { source: path.join(source, "sessions"), destination: baseline[0]!.destination },
    { source: path.join(source, "archived_sessions"), destination: baseline[1]!.destination },
  ]);
  expect(vendorLocalSourceRoots("codex", profiles, declarations)).toContain(path.join(source, "sessions"));
  expect(profileMirrorTargets("codex", profiles, [{ ...declarations[0]!, machine: "other-machine" }])).toEqual(baseline);
  expect(profileMirrorTargets("claude", profiles, [{ vendor: "claude", source_home: source, home }])).toContainEqual({ source: path.join(source, "projects"), destination: home });
});
test("saving a moved profile preserves account metadata and changes only the physical source", async () => {
  const root = fixture();
  const profile = path.join(root, ".codex-mr");
  const config = path.join(root, "config");
  const auth = (email: string) => ({ tokens: { account_id: email, id_token: "h." + Buffer.from(JSON.stringify({ email })).toString("base64url") + ".s" } });
  write(root, ".codex-mr/auth.json", auth("mr@example.com"));
  const metadata = { id: "mr", vendor: "codex", account: "mr@example.com", note: "history" };
  const original = { vendor: "codex", machine: MACHINE, home: path.join(root, "archive", "codex", "old"),
    source_home: path.join(root, "old-profile") };
  write(root, "config/accounts.json", { version: 2, subscriptions: [metadata], sources: [original] });
  const script = [
    'import fs from "node:fs";',
    'import {saveSetup} from ' + JSON.stringify(path.resolve(import.meta.dir, "../server/setup.ts")) + ';',
    'const file = ' + JSON.stringify(path.join(config, "accounts.json")) + ';',
    'const source = ' + JSON.stringify({ ...original, source_home: profile }) + ';',
    'saveSetup({sources:[source]});',
    'const saved=JSON.parse(fs.readFileSync(file,"utf8"));',
    'if(saved.version!==2||JSON.stringify(saved.subscriptions)!==' + JSON.stringify(JSON.stringify([metadata])) + ') throw Error("metadata changed");',
    'if(JSON.stringify(saved.sources)!==JSON.stringify([source])) throw Error("source not moved");'
  ].join("\n");
  const file = path.join(root, "test-save.ts"); fs.writeFileSync(file, script);
  const proc = Bun.spawn([process.execPath, file], { env: { ...process.env, TOKENATLAS_CONFIG: config, TOKENATLAS_ARCHIVE: path.join(root, "archive"), TOKENATLAS_LOCAL_STATE: path.join(root, "state") }, stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  expect({ exit: await proc.exited, stderr }).toEqual({ exit: 0, stderr: "" });
});
