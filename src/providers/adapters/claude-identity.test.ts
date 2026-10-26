import { beforeEach, expect, test } from "bun:test";
import { claudeProbeAdapter, resetClaudeIdentityCache } from "./claude";
import { fetchProbeJson } from "../core/probe";
import { ProviderProbeError, type ProbeHttpResponse } from "../types";

const ACCOUNT = "11111111-2222-3333-4444-555555550001";
const ORG = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0002";
const PROFILE = "https://api.anthropic.com/api/oauth/profile";
const USAGE = "https://api.anthropic.com/api/oauth/usage";
const usage = { five_hour: { utilization: 12, resets_at: "2026-10-06T15:00:00Z" } };
const expected: { accountId: string | null; organizationId: string | null; email: string | null } =
  { accountId: ACCOUNT, organizationId: ORG, email: "one@example.com" };

beforeEach(() => resetClaudeIdentityCache());

/** A probe whose profile answer is fixed; the usage call always succeeds. */
function probe(profile: ProbeHttpResponse<unknown> | (() => never), options: { token?: string; expiresAt?: number | null; identity?: typeof expected } = {}) {
  const calls: string[] = [];
  const fetchJson = async (url: string) => {
    calls.push(url);
    if (url === USAGE) return { ok: true, status: 200, body: usage };
    return typeof profile === "function" ? profile() : profile;
  };
  const run = () => claudeProbeAdapter.request(
    { subscription: "one", expectedIdentity: options.identity ?? expected },
    { credentials: { token: options.token ?? "token-a", expires_at: options.expiresAt ?? null, subscription_type: "max" }, fetchJson: fetchJson as never });
  return { calls, run };
}
const ok = (account: unknown, organization: unknown = { uuid: ORG }) => ({ ok: true, status: 200, body: { account, organization } });
const refused = (status: number, retryAfter: string | null = null) => ({ ok: false, status, body: null, retryAfter });

test("a profile that answers with the same owner lets the usage reading through, and the owner is reused for that token", async () => {
  const { calls, run } = probe(ok({ uuid: ACCOUNT, email: "one@example.com" }));
  expect((await run()).usage).toEqual(usage);
  expect(calls).toEqual([PROFILE, USAGE]);
  await run();
  expect(calls).toEqual([PROFILE, USAGE, USAGE]);
  // A refreshed token is verified again.
  const next = probe(ok({ uuid: ACCOUNT, email: "one@example.com" }), { token: "token-b" });
  await next.run();
  expect(next.calls).toEqual([PROFILE, USAGE]);
});

test("a confirmed owner is not reused past the token's expiry", async () => {
  const { calls, run } = probe(ok({ uuid: ACCOUNT, email: "one@example.com" }), { expiresAt: Date.now() + 50 });
  await run();
  await Bun.sleep(80);
  await run().catch(() => undefined);
  expect(calls.filter(url => url === PROFILE)).toHaveLength(2);
});

test("a different owner names the differing field by its last characters and withholds usage", async () => {
  const other = "99999999-8888-7777-6666-55555555abcd";
  const account = probe(ok({ uuid: other, email: "one@example.com" }));
  const error = await account.run().catch((e: Error) => e);
  expect(error).toBeInstanceOf(ProviderProbeError);
  expect((error as Error).message).toBe("[login-mismatch] Claude OAuth identity does not match this profile (account …abcd, expected …0001); usage was not attributed.");
  expect((error as Error).message).not.toContain(other);
  expect(account.calls).toEqual([PROFILE]);
  // The mismatch is remembered for the token too: the owner of a token never changes.
  await account.run().catch(() => undefined);
  expect(account.calls).toEqual([PROFILE]);

  resetClaudeIdentityCache();
  const organization = probe(ok({ uuid: ACCOUNT }, { uuid: "ffffffff-0000-0000-0000-000000009999" }));
  await expect(organization.run()).rejects.toThrow("(organization …9999, expected …0002)");

  resetClaudeIdentityCache();
  const missing = probe(ok({ email: "one@example.com" }));
  await expect(missing.run()).rejects.toThrow("(the profile answer has no account uuid, expected …0001)");

  resetClaudeIdentityCache();
  const byEmail = probe(ok({ uuid: ACCOUNT, email: "two@example.com" }), { identity: { accountId: null, organizationId: null, email: "one@example.com" } });
  await expect(byEmail.run()).rejects.toThrow("(email t…@example.com, expected o…@example.com)");
});

test("HTTP 401 is a coded expired sign-in, for an expired or a rejected token", async () => {
  const stale = probe(refused(401), { expiresAt: Date.now() - 60_000 });
  await expect(stale.run()).rejects.toThrow("[login-expired] Claude sign-in expired: the access token expired (HTTP 401 from the profile endpoint); run `claude` and sign in (/login).");
  expect(stale.calls).toEqual([PROFILE]);
  const rejected = probe(refused(401));
  await expect(rejected.run()).rejects.toThrow("[login-expired] Claude sign-in expired: the access token was rejected, revoked or replaced (HTTP 401 from the profile endpoint)");
});

test("HTTP 403 says the token lacks the profile scope", async () => {
  const { calls, run } = probe(refused(403));
  await expect(run()).rejects.toThrow("HTTP 403, the token lacks the user:profile scope");
  expect(calls).toEqual([PROFILE]);
});

test("HTTP 429 reports Retry-After and backs off without asking again", async () => {
  const { calls, run } = probe(refused(429, "120"));
  await expect(run()).rejects.toThrow("HTTP 429, the profile endpoint is rate limiting this token (Retry-After 120); usage was not attributed.");
  await expect(run()).rejects.toThrow(/rate limiting this token \(HTTP 429\), next check after \d{4}-/);
  expect(calls).toEqual([PROFILE]);
  const bare = probe(refused(429), { token: "token-c" });
  await expect(bare.run()).rejects.toThrow("(no Retry-After)");
});

test("a timeout, an unreachable endpoint and a server error are each named", async () => {
  // fetchProbeJson turns an abort into a ProviderProbeError carrying the caller's message.
  const timeout = probe(() => { throw new ProviderProbeError("Claude identity check failed: no answer from the profile endpoint in 8000 ms; usage was not attributed."); });
  await expect(timeout.run()).rejects.toThrow("no answer from the profile endpoint in 8000 ms");
  expect(timeout.calls).toEqual([PROFILE]);
  const offline = probe(() => { throw new TypeError("fetch failed"); });
  await expect(offline.run()).rejects.toThrow("Claude identity check failed: the profile endpoint could not be reached (fetch failed); usage was not attributed.");
  await expect(probe(refused(503)).run()).rejects.toThrow("HTTP 503, the profile endpoint failed at Anthropic");
});

test("the probe fetch passes Retry-After through", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("slow down", { status: 429, headers: { "Retry-After": "30" } }) });
  try {
    expect(await fetchProbeJson(`http://127.0.0.1:${server.port}/`, { method: "GET" }, 2_000, "timeout"))
      .toEqual({ ok: false, status: 429, body: null, retryAfter: "30" });
  } finally {
    server.stop(true);
  }
});
