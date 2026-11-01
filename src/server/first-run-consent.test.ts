import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// TALK-001 D3/D4: before the consent screen is accepted nothing leaves this computer, also after a restart;
// an "off" chosen there stays off whatever TOKENATLAS_PROBE_MINUTES says. Probes are enabled (1 min) on
// purpose, with synthetic Codex and Claude sign-ins, so a missing gate would show as outbound traffic.
interface Run { outbound: string[]; codexPolls: number; login: number; confirmed: boolean | null; preview: { sources: Array<{ vendor: string; files: number; bytes: number }> } | null }

async function startOnce(root: string, consent?: { limit_readings: boolean; cloud_import: boolean }): Promise<Run> {
  const script = path.join(root, `start-${Math.random().toString(36).slice(2)}.ts`);
  fs.writeFileSync(script, `
    const outbound = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
        outbound.push(url.host);
        return new Response("{}", { status: 401 });
      }
      return realFetch(input, init);
    };
    let codexPolls = 0;
    const { startServer } = await import(${JSON.stringify(path.join(import.meta.dir, "api.ts"))});
    const running = startServer(0, ${JSON.stringify(path.join(root, "atlas.sqlite"))}, {
      codexProbeRunner: async () => { codexPolls++; },
    });
    const base = "http://127.0.0.1:" + running.server.port;
    const preview = await (await fetch(base + "/api/setup/preview")).json();
    // The Claude CLI sign-in goes online, so it is refused until the consent screen is accepted.
    const login = (await fetch(base + "/api/claude-login", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: "claude" }) })).status;
    let confirmed = null;
    const consent = ${JSON.stringify(consent ?? null)};
    if (consent) confirmed = (await (await fetch(base + "/api/setup/confirm", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(consent) })).json()).locations_confirmed;
    // Probes are first scheduled 3 and 4 seconds after the start.
    await new Promise(resolve => setTimeout(resolve, 6500));
    running.close?.();
    process.stdout.write(JSON.stringify({ outbound, codexPolls, login, confirmed, preview }));
    process.exit(0);`);
  const profile = path.join(root, "profile");
  const child = Bun.spawn([process.execPath, script], {
    env: { ...process.env, TOKENATLAS_CONFIG: path.join(root, "config"), TOKENATLAS_ARCHIVE: path.join(root, "archive"),
      TOKENATLAS_LOCAL_STATE: path.join(root, "state"), TOKENATLAS_SYNC_MINUTES: "0", TOKENATLAS_PROBE_MINUTES: "1",
      TOKENATLAS_GEMINI_MINUTES: "0", TOKENATLAS_CLOUD_MINUTES: "1", TOKENATLAS_CONFIRM_LOCATIONS: "",
      USERPROFILE: profile, HOME: profile, APPDATA: path.join(profile, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(profile, "AppData", "Local"), CODEX_HOME: "", CLAUDE_CONFIG_DIR: "", GROK_HOME: "", OneDrive: "" },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`server exited ${code}: ${stderr}`);
  return JSON.parse(stdout.slice(stdout.lastIndexOf("{\"outbound\"")));
}

const jwt = (claims: object) => ["{}", JSON.stringify(claims), ""].map(part => Buffer.from(part).toString("base64url")).join(".");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-first-run-consent-"));
  const profile = path.join(root, "profile");
  for (const dir of ["config", "archive", "state", "profile/AppData/Roaming", "profile/AppData/Local", "profile/.codex/sessions/2026/10/31", "profile/.claude/projects/demo"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "accounts.json"), JSON.stringify({ version: 2, subscriptions: [], sources: [] }));
  fs.writeFileSync(path.join(profile, ".codex", "auth.json"), JSON.stringify({ tokens: {
    id_token: jwt({ email: "tester@example.test", "https://api.openai.com/auth": { chatgpt_account_id: "acct-synthetic" } }), account_id: "acct-synthetic" } }));
  fs.writeFileSync(path.join(profile, ".codex", "sessions", "2026", "10", "31", "rollout-synthetic.jsonl"), "{}\n");
  fs.writeFileSync(path.join(profile, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: {
    accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: Date.now() + 86_400_000, subscriptionType: "max" } }));
  fs.writeFileSync(path.join(profile, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "tester@example.test",
    accountUuid: "11111111-1111-4111-8111-111111111111", organizationUuid: "22222222-2222-4222-8222-222222222222" } }));
  fs.writeFileSync(path.join(profile, ".claude", "projects", "demo", "session.jsonl"), "{}\n{}\n");
  return root;
}
const cleanup = (root: string) => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
const contacted = (run: Run) => run.outbound.length > 0 || run.codexPolls > 0;

test("nothing reaches the network before consent, also after a restart; agreeing with readings off keeps them off", async () => {
  const root = fixture();
  try {
    const waiting = await startOnce(root);
    expect(waiting.outbound).toEqual([]);
    expect(waiting.codexPolls).toBe(0);
    expect(waiting.login).toBe(409);
    // The screen's facts come from a read-only scan: both synthetic sources with their files and bytes.
    const sources = Object.fromEntries(waiting.preview!.sources.map(source => [source.vendor, source]));
    expect(sources.claude).toMatchObject({ files: 1, bytes: 6 });
    expect(sources.codex).toMatchObject({ files: 1, bytes: 3 });
    expect(fs.readdirSync(path.join(root, "archive"))).toEqual([]);

    const restarted = await startOnce(root);
    expect(contacted(restarted)).toBe(false);

    const agreed = await startOnce(root, { limit_readings: false, cloud_import: false });
    expect(agreed.confirmed).toBe(true);
    expect(contacted(agreed)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(root, "state", "limit-readings-settings.json"), "utf8"))).toEqual({ schema: 1, enabled: false });
    // TOKENATLAS_CLOUD_MINUTES=1 in the environment cannot lift the stored "off".
    expect(JSON.parse(fs.readFileSync(path.join(root, "state", "claude-cloud-settings.json"), "utf8"))).toEqual({ schema: 1, minutes: 0 });

    const later = await startOnce(root);
    expect(contacted(later)).toBe(false);
  } finally { cleanup(root); }
}, 300_000);

test("after agreeing with readings on, the restarted server reads limits (control for the gate above)", async () => {
  const root = fixture();
  try {
    expect((await startOnce(root, { limit_readings: true, cloud_import: false })).confirmed).toBe(true);
    expect(contacted(await startOnce(root))).toBe(true);
  } finally { cleanup(root); }
}, 300_000);
