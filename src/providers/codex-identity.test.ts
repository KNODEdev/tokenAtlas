import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCodexAccountIdentity, scanCodexProfiles, codexIdentityEvidence } from "./codex-identity";
import { resolveCodexDiscovery } from "../server/codex-discovery";
import { codexProbeAdapter } from "./adapters/codex";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture(login: string, accountId: string, email: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-identity-")); dirs.push(root);
  const home = path.join(root, login, ".codex"); fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ tokens: { account_id: accountId, access_token: "SECRET",
    id_token: `head.${Buffer.from(JSON.stringify({ email, "https://api.openai.com/auth": { chatgpt_account_id: "other-workspace" } })).toString("base64url")}.signature` } }));
  return { root, home };
}
test("identity uses the selected account, normalizes email and never returns credentials", () => {
  const { home } = fixture("one", "account-one", "ONE@EXAMPLE.COM");
  const result = readCodexAccountIdentity(home);
  expect(result).toEqual({ identity: { account_id: "account-one", email: "one@example.com", key: "account:account-one" }, error: null });
  expect(JSON.stringify(result)).not.toContain("SECRET");
  const target = { home, account: "codex1", identity: { ...result.identity!, subscription: "codex1", home, login: "one", machine: "PC" } };
  expect(codexProbeAdapter.credentials(target).creds).not.toBeNull();
  fs.writeFileSync(path.join(home, "auth.json"), '{"access_token":"SECRET",bad');
  expect(codexProbeAdapter.credentials(target).creds).toBeNull();
  expect(readCodexAccountIdentity(home).identity).toBeNull();
  expect(JSON.stringify(readCodexAccountIdentity(home))).not.toContain("SECRET");
});
test("Windows discovery inspects sibling profiles and deduplicates custom homes", () => {
  const { root, home } = fixture("one", "account-one", "one@example.com");
  const second = path.join(root, "two", ".codex"); fs.mkdirSync(second, { recursive: true });
  fs.copyFileSync(path.join(home, "auth.json"), path.join(second, "auth.json"));
  fs.mkdirSync(path.join(root, "unused"));
  const profiles = scanCodexProfiles({ home: path.dirname(home), platform: "win32", machine: "PC", codexHome: home });
  expect(profiles.map(p => p.login).sort()).toEqual(["one", "two"]);
  const accounts = resolveCodexDiscovery(profiles, [{ id: "codex1", account: "one@example.com" }], [], "PC");
  expect(accounts.accounts).toHaveLength(1);
  expect(accounts.accounts[0]!.id).toBe("codex1");
  expect(accounts.accounts[0]!.profiles).toHaveLength(2);
});
test("a new account gets a stable id independent of the Windows login, without guessing history", () => {
  const { home } = fixture("one", "account-one", "one@example.com");
  const identity = readCodexAccountIdentity(home).identity!;
  const profile = { home, identity, login: "one", machine: "PC", error: null };
  const first = resolveCodexDiscovery([profile], []);
  const other = resolveCodexDiscovery([{ ...profile, home: "/other", login: "different", machine: "LAPTOP" }], []);
  expect(first.accounts[0]!.id).toBe(other.accounts[0]!.id);
  expect(first.accounts[0]!.id).toMatch(/^chatgpt-/);
});
test("different workspaces sharing an email are separate, and ambiguous aliases are not guessed", () => {
  const profiles = ["first", "second"].map(id => ({ home: id, login: id, machine: "PC", error: null,
    identity: { account_id: id, key: `account:${id}`, email: "same@example.com" } }));
  const result = resolveCodexDiscovery(profiles, [{ id: "codex1", account: "same@example.com" }]);
  expect(new Set(result.accounts.map(a => a.id)).size).toBe(2);
  expect(result.accounts.some(a => a.id === "codex1")).toBe(false);
});
test("relogin creates a new current account and retains the previous account's identity", () => {
  const old = { key: "account:old", account_id: "old", email: "old@example.com", subscription: "codex2", home: "/profile", login: "one", machine: "PC" };
  const result = resolveCodexDiscovery([{ home: old.home, login: old.login, machine: "PC", error: null,
    identity: { key: "account:new", account_id: "new", email: "new@example.com" } }], [], [old], "PC");
  expect(result.accounts.find(a => a.id === "codex2")?.current).toBe(false);
  expect(result.accounts.find(a => a.email === "new@example.com")?.current).toBe(true);
  expect(codexIdentityEvidence(JSON.stringify({ codex_account: JSON.stringify(old) }))).toEqual(old);
  expect(codexIdentityEvidence('{"codex_account":"invalid"}')).toBeNull();
});
