import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeTestFixture } from "../test-cleanup";
import { ensureArchiveIdentity } from "./archive-inventory";
import type { CloudGet } from "./claude-cloud-api";
import { eventsToAppend, lastJsonlRecord, syncClaudeCloudSessions, type CloudProfile } from "./claude-cloud-sync";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTestFixture(root, { recursive: true, force: true }); });

const event = (n: number) => ({ event_id: `e${n}`, event_type: "assistant", sequence_num: String(n),
  payload: { type: "assistant", message: { id: `msg_${n}`, usage: { input_tokens: n } } } });

/** A fake provider: one cloud session and one bridge session; events from a cursor `c<n>` continue after n. */
function provider(initial: { events: number; updatedAt: string }) {
  const remote = { ...initial, calls: [] as string[], gap: false, account: "00000000-0000-4000-8000-000000000001" };
  const get: CloudGet = async (url, headers) => {
    const u = new URL(url);
    remote.calls.push(`${u.pathname}${u.search}`);
    expect(headers["anthropic-beta"]).toBe(u.pathname === "/api/oauth/profile" ? "oauth-2025-04-20" : "ccr-byoc-2025-07-29");
    if (u.pathname === "/api/oauth/profile") return { status: 200, text: JSON.stringify({
      account: { uuid: remote.account }, organization: { uuid: "00000000-0000-4000-8000-0000000000aa" } }) };
    if (u.pathname === "/v1/sessions") return { status: 200, text: JSON.stringify({ has_more: false, data: [
      { id: "session_cloud1", environment_kind: "anthropic_cloud", updated_at: remote.updatedAt, title: "t",
        session_context: { cwd: "", environment_variables: { SECRET: "x" }, mcp_config: { token: "y" },
          sources: [{ type: "git_repository", url: "https://github.com/Owner/TactShift" }] } },
      { id: "session_bridge", environment_kind: "bridge", updated_at: remote.updatedAt },
    ] }) };
    expect(headers["X-Trusted-Device-Token"]).toBe("device");
    const after = Number(u.searchParams.get("cursor")?.slice(1) ?? 0);
    const numbers = Array.from({ length: Math.max(0, remote.events - after) }, (_, i) => after + i + 1)
      .filter(n => !(remote.gap && n === after + 1));
    return { status: 200, text: JSON.stringify({ data: numbers.map(event), resume_cursor: `c${remote.events}` }) };
  };
  return { remote, get };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-cloud-"));
  roots.push(root);
  const archiveRoot = path.join(root, "archive");
  fs.mkdirSync(archiveRoot);
  ensureArchiveIdentity(archiveRoot);
  const profile: CloudProfile = { sourceHome: path.join(root, "home", ".claude"), archiveDir: path.join(archiveRoot, "claude", "PC-cloud") };
  let n = 0;
  const options = (get: CloudGet, stateRoot = path.join(root, "state")) => ({
    get, archiveRoot, stateRoot, profiles: [profile],
    auth: async () => ({ token: "token", trustedDevice: "device" }),
    workspace: () => {
      const directory = path.join(root, "temp", `w${n++}`);
      fs.mkdirSync(directory, { recursive: true });
      return { directory, dispose: () => fs.rmSync(directory, { recursive: true, force: true }) };
    },
    projects: () => ({ projects: [] }),
    repositories: () => ({ paths: { "https://github.com/owner/tactshift": "H:/repos/products/TactShift" } }),
  });
  const events = path.join(profile.archiveDir, "session_cloud1.events.jsonl");
  const session = path.join(profile.archiveDir, "session_cloud1.session.jsonl");
  const lines = (file: string) => fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
  return { root, options, events, session, lines };
}

describe("eventsToAppend", () => {
  test("accepts consecutive events after the archived end and skips a re-read prefix", () => {
    expect(eventsToAppend([event(1), event(2)], null, false).map(e => e.event_id)).toEqual(["e1", "e2"]);
    expect(eventsToAppend([event(1), event(2), event(3)], event(2), false).map(e => e.event_id)).toEqual(["e3"]);
    expect(eventsToAppend([], event(2), true)).toEqual([]);
  });
  test("refuses gaps, repeats after a cursor and a different archived end", () => {
    expect(() => eventsToAppend([event(2)], null, false)).toThrow("events 1..1 are missing");
    expect(() => eventsToAppend([event(2)], event(2), true)).toThrow("repeated");
    expect(() => eventsToAppend([{ ...event(2), event_id: "other" }], event(2), false)).toThrow("differs");
    expect(() => eventsToAppend([{ event_id: "e1", sequence_num: "x" }], null, false)).toThrow("sequence_num");
  });
});

describe("lastJsonlRecord", () => {
  test("reads the last record of a file larger than one read chunk", () => {
    const f = fixture();
    const file = path.join(f.root, "big.jsonl");
    fs.writeFileSync(file, `${JSON.stringify({ pad: "x".repeat(200_000) })}\n${JSON.stringify({ last: 1 })}\n`);
    expect(lastJsonlRecord(file)).toEqual({ last: 1 });
    fs.writeFileSync(file, `${JSON.stringify({ only: "y".repeat(150_000) })}\n`);
    expect(lastJsonlRecord(file)).toEqual({ only: "y".repeat(150_000) });
    expect(lastJsonlRecord(path.join(f.root, "missing.jsonl"))).toBeNull();
  });
});

describe("syncClaudeCloudSessions", () => {
  test("archives only cloud sessions, then only what changed, resuming from the cursor", async () => {
    const f = fixture();
    const p = provider({ events: 3, updatedAt: "2026-10-23T10:00:00Z" });
    const first = await syncClaudeCloudSessions(f.options(p.get));
    expect(first.profiles[0]).toMatchObject({ sessions: 1, changed: 1, published: 1, errors: [] });
    expect(f.lines(f.events).map(e => e.sequence_num)).toEqual(["1", "2", "3"]);
    const declaration = f.lines(f.session);
    expect(declaration).toHaveLength(1);
    expect(declaration[0].places).toEqual([{ repository: "https://github.com/Owner/TactShift", remote: "/home/user/TactShift",
      local: "H:/repos/products/TactShift" }]);
    expect(declaration[0].owner).toEqual({ account_key: "claude:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-0000000000aa" });
    expect(JSON.stringify(declaration)).not.toContain("SECRET");
    expect(JSON.stringify(declaration)).not.toContain("mcp_config");
    expect(p.remote.calls.filter(call => call.includes("session_bridge"))).toEqual([]);

    // Unchanged `updated_at`: the list is read, no events are requested.
    p.remote.calls.length = 0;
    expect((await syncClaudeCloudSessions(f.options(p.get))).profiles[0]).toMatchObject({ changed: 0, published: 0 });
    expect(p.remote.calls.every(call => call.startsWith("/v1/sessions") || call.startsWith("/api/oauth/profile"))).toBe(true);
    expect(f.lines(f.session)).toHaveLength(1);

    // A new owner (or clone) is declared even when the session has not changed, so its events are read again.
    p.remote.account = "00000000-0000-4000-8000-000000000002";
    expect((await syncClaudeCloudSessions(f.options(p.get))).archived).toEqual([f.session]);
    expect(f.lines(f.session).at(-1).owner.account_key).toContain("000000000002");
    p.remote.account = "00000000-0000-4000-8000-000000000001";
    await syncClaudeCloudSessions(f.options(p.get));

    // Changed: the read continues from the stored cursor and appends only the new events.
    p.remote.events = 5; p.remote.updatedAt = "2026-10-23T11:00:00Z"; p.remote.calls.length = 0;
    expect((await syncClaudeCloudSessions(f.options(p.get))).profiles[0]).toMatchObject({ changed: 1, published: 1 });
    expect(p.remote.calls.find(call => call.includes("/events"))).toContain("cursor=c3");
    expect(f.lines(f.events).map(e => e.sequence_num)).toEqual(["1", "2", "3", "4", "5"]);
    expect(f.lines(f.session)).toHaveLength(3);
  });

  test("a lost checkpoint re-reads from the start without duplicating archived events", async () => {
    const f = fixture();
    const p = provider({ events: 2, updatedAt: "a" });
    await syncClaudeCloudSessions(f.options(p.get));
    p.remote.events = 3; p.remote.updatedAt = "b";
    const result = await syncClaudeCloudSessions(f.options(p.get, path.join(f.root, "fresh-state")));
    expect(result.profiles[0]!.errors).toEqual([]);
    expect(f.lines(f.events).map(e => e.event_id)).toEqual(["e1", "e2", "e3"]);
  });

  test("a gap leaves the archive unchanged and reports the session", async () => {
    const f = fixture();
    const p = provider({ events: 2, updatedAt: "a" });
    await syncClaudeCloudSessions(f.options(p.get));
    const before = fs.readFileSync(f.events, "utf8");
    p.remote.events = 4; p.remote.updatedAt = "b"; p.remote.gap = true;
    const result = await syncClaudeCloudSessions(f.options(p.get));
    expect(result.profiles[0]!.errors[0]).toContain("events 3..3 are missing");
    expect(fs.readFileSync(f.events, "utf8")).toBe(before);
    // The checkpoint was not advanced, so the next run retries the same session.
    p.remote.gap = false;
    expect((await syncClaudeCloudSessions(f.options(p.get))).profiles[0]).toMatchObject({ changed: 1, published: 1, errors: [] });
    expect(f.lines(f.events)).toHaveLength(4);
  });

  test("a profile without a trusted device reports once and reads no events", async () => {
    const f = fixture();
    const p = provider({ events: 1, updatedAt: "a" });
    const result = await syncClaudeCloudSessions({ ...f.options(p.get), auth: async () => ({ token: "token", trustedDevice: null }) });
    expect(result.profiles[0]!.errors).toEqual([expect.stringContaining("trusted device")]);
    expect(fs.existsSync(f.events)).toBe(false);
  });
});
