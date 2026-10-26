import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import os from "node:os";
import path from "node:path";
import {
  acknowledgeUncopiedRelocationDisappearance,
  advanceArchiveRelocation,
  assertArchiveRelocationSwitchAllowed,
  readArchiveRelocation,
  startArchiveRelocation,
  type ArchiveRelocationState,
} from "./archive-relocation";
import { ensureArchiveIdentity } from "./archive-inventory";
import { prepareArchiveConnection, readArchiveIdentity } from "../config/archive-location";
import { atomicArchiveWrite } from "./archive-publication";
import {
  bindCanonicalArchiveRoot,
  canonicalArchivePath,
  physicalArchivePath,
} from "../config/archive-paths";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) removeTestFixture(directory, { recursive: true, force: true });
});

function fixture(): { base: string; source: string; destination: string; stateDirectory: string; archiveId: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-relocation-"));
  temporary.push(base);
  const source = path.join(base, "source");
  const destination = path.join(base, "destination");
  const stateDirectory = path.join(base, "local-state");
  fs.mkdirSync(path.join(source, "codex", "profile"), { recursive: true });
  fs.mkdirSync(path.join(source, "claude", "profile"), { recursive: true });
  fs.mkdirSync(path.join(source, "config"), { recursive: true });
  fs.writeFileSync(path.join(source, "codex", "profile", "events.jsonl"), "{\"tokens\":1}\n");
  fs.writeFileSync(path.join(source, "claude", "profile", "events.jsonl"), "{\"cost\":\"1.25\"}\n");
  fs.writeFileSync(path.join(source, "config", "claude-gauge.json"), "{\"remaining\":50}\n");
  const archiveId = ensureArchiveIdentity(source);
  return { base, source, destination, stateDirectory, archiveId };
}

async function drive(state: ArchiveRelocationState, stateDirectory: string): Promise<ArchiveRelocationState> {
  for (let attempt = 0; attempt < 100 && state.phase !== "ready-to-switch"; attempt++) {
    state = await advanceArchiveRelocation(state.jobId, { stateDirectory, maxFiles: 2, maxBytes: 1024 });
  }
  expect(state.phase).toBe("ready-to-switch");
  return state;
}

describe("archive relocation staging", () => {
  test("staged destinations cannot be activated by setup or ordinary writers", async () => {
    const f = fixture();
    let state = startArchiveRelocation(f.source, f.destination, { stateDirectory: f.stateDirectory });
    state = await advanceArchiveRelocation(state.jobId, { stateDirectory: f.stateDirectory, maxFiles: 1, maxBytes: 1 });
    const candidate = path.join(f.destination, "config", "accounts.json");
    for (let step = 0; step < 2; step++) {
      expect(() => atomicArchiveWrite(candidate, "wrong")).toThrow("destination is staged");
      expect(() => prepareArchiveConnection(f.destination, "connect", { database: path.join(f.base, "atlas.sqlite") })).toThrow("destination is staged");
      expect(fs.existsSync(candidate)).toBe(false);
      if (!step) state = await drive(state, f.stateDirectory);
    }
    expect(fs.readFileSync(path.join(f.destination, "config", "claude-gauge.json"), "utf8")).toBe('{"remaining":50}\n');
  });
  test("copies, reopens, verifies, and preserves identity and canonical paths", async () => {
    const f = fixture();
    let state = startArchiveRelocation(f.source, f.destination, { stateDirectory: f.stateDirectory });
    state = await advanceArchiveRelocation(state.jobId, { stateDirectory: f.stateDirectory, maxFiles: 1, maxBytes: 1 });
    const reopened = readArchiveRelocation(f.stateDirectory, state.jobId);
    expect(reopened.jobId).toBe(state.jobId);
    state = await drive(reopened, f.stateDirectory);

    expect(readArchiveIdentity(f.destination)).toBe(f.archiveId);
    expect(fs.readFileSync(path.join(f.destination, "codex", "profile", "events.jsonl"), "utf8"))
      .toBe("{\"tokens\":1}\n");
    expect(fs.readFileSync(path.join(f.source, "codex", "profile", "events.jsonl"), "utf8"))
      .toBe("{\"tokens\":1}\n");

    const original = bindCanonicalArchiveRoot(null, f.archiveId, f.source);
    const moved = bindCanonicalArchiveRoot(original, f.archiveId, f.destination);
    const logical = canonicalArchivePath(moved, path.join(f.destination, "codex", "profile", "events.jsonl"));
    expect(logical).toBe(path.join(f.source, "codex", "profile", "events.jsonl"));
    expect(physicalArchivePath(moved, logical)).toBe(path.join(f.destination, "codex", "profile", "events.jsonl"));
    expect(() => canonicalArchivePath(moved, path.join(f.base, "external.jsonl"))).toThrow("outside archive root");
    expect(() => bindCanonicalArchiveRoot(moved, "another-archive", f.destination)).toThrow("identity changed");
    expect(() => assertArchiveRelocationSwitchAllowed(state)).toThrow("all-writer fencing");
  });

  test("preserves exact fractional modification-time bookmarks and repairs metadata drift", async () => {
    const f = fixture();
    const sourceFile = path.join(f.source, "codex", "profile", "events.jsonl");
    const requestedSeconds = 1_700_000_000.1234567;
    fs.utimesSync(sourceFile, requestedSeconds, requestedSeconds);
    const sourceBookmark = fs.statSync(sourceFile).mtimeMs;
    expect(Number.isInteger(sourceBookmark)).toBe(false);

    let state = await drive(
      startArchiveRelocation(f.source, f.destination, { stateDirectory: f.stateDirectory }),
      f.stateDirectory,
    );
    const destinationFile = path.join(f.destination, "codex", "profile", "events.jsonl");
    expect(fs.statSync(destinationFile).mtimeMs).toBe(sourceBookmark);

    fs.utimesSync(destinationFile, requestedSeconds + 1, requestedSeconds + 1);
    expect(fs.statSync(destinationFile).mtimeMs).not.toBe(sourceBookmark);
    state = await advanceArchiveRelocation(state.jobId, {
      stateDirectory: f.stateDirectory,
      maxFiles: 100,
      maxBytes: 1024 * 1024,
    });
    expect(state.phase).toBe("copying");
    state = await drive(state, f.stateDirectory);
    expect(fs.statSync(destinationFile).mtimeMs).toBe(sourceBookmark);
  });

  test("catches up an append that arrives after bounded copying started", async () => {
    const f = fixture();
    let state = startArchiveRelocation(f.source, f.destination, { stateDirectory: f.stateDirectory });
    state = await advanceArchiveRelocation(state.jobId, { stateDirectory: f.stateDirectory, maxFiles: 1, maxBytes: 1 });
    const sourceFile = path.join(f.source, "codex", "profile", "events.jsonl");
    fs.appendFileSync(sourceFile, "{\"tokens\":2}\n");
    state = await drive(state, f.stateDirectory);
    expect(fs.readFileSync(path.join(f.destination, "codex", "profile", "events.jsonl"), "utf8"))
      .toBe(fs.readFileSync(sourceFile, "utf8"));
  });

  test("repairs target corruption on a new verification pass", async () => {
    const f = fixture();
    let state = await drive(
      startArchiveRelocation(f.source, f.destination, { stateDirectory: f.stateDirectory }),
      f.stateDirectory,
    );
    const destinationFile = path.join(f.destination, "claude", "profile", "events.jsonl");
    fs.writeFileSync(destinationFile, "corrupt");
    state = await advanceArchiveRelocation(state.jobId, { stateDirectory: f.stateDirectory, maxFiles: 100, maxBytes: 1024 * 1024 });
    state = await drive(state, f.stateDirectory);
    expect(fs.readFileSync(destinationFile, "utf8")).toBe("{\"cost\":\"1.25\"}\n");
  });

  test("keeps a failed job retryable when a known source disappears", async () => {
    const f = fixture();
    let state = startArchiveRelocation(f.source, f.destination, { stateDirectory: f.stateDirectory });
    state = await advanceArchiveRelocation(state.jobId, { stateDirectory: f.stateDirectory, maxFiles: 1, maxBytes: 1 });
    const sourceFile = path.join(f.source, "codex", "profile", "events.jsonl");
    const bytes = fs.readFileSync(sourceFile);
    fs.unlinkSync(sourceFile);
    await expect(advanceArchiveRelocation(state.jobId, { stateDirectory: f.stateDirectory }))
      .rejects.toThrow("disappeared during relocation");
    fs.writeFileSync(sourceFile, bytes);
    state = readArchiveRelocation(f.stateDirectory, state.jobId);
    state = await drive(state, f.stateDirectory);
    expect(state.lastError).toBeUndefined();
  });

  test("rejects overlap and preserves foreign target data", () => {
    const f = fixture();
    expect(() => startArchiveRelocation(f.source, path.join(f.source, "nested"), { stateDirectory: f.stateDirectory }))
      .toThrow("equal, nested, or overlapping");
    fs.mkdirSync(f.destination, { recursive: true });
    fs.writeFileSync(path.join(f.destination, "foreign.txt"), "do not overwrite");
    expect(() => startArchiveRelocation(f.source, f.destination, { stateDirectory: f.stateDirectory }))
      .toThrow("empty or owned");
    expect(fs.readFileSync(path.join(f.destination, "foreign.txt"), "utf8")).toBe("do not overwrite");
  });

  test("yields during a file larger than the copy chunk", async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.source, "codex", "profile", "large.bin"), Buffer.alloc(5 * 1024 * 1024, 7));
    const state = startArchiveRelocation(f.source, f.destination, { stateDirectory: f.stateDirectory });
    let heartbeats = 0;
    let running = true;
    const beat = () => {
      heartbeats++;
      if (running) setImmediate(beat);
    };
    setImmediate(beat);
    await advanceArchiveRelocation(state.jobId, {
      stateDirectory: f.stateDirectory,
      maxFiles: 100,
      maxBytes: 64 * 1024 * 1024,
    });
    running = false;
    expect(heartbeats).toBeGreaterThan(2);
  });

  test("malformed state releases its lock and can be retried after repair", async () => {
    const f = fixture();
    const state = startArchiveRelocation(f.source, f.destination, { stateDirectory: f.stateDirectory });
    const stateFile = path.join(f.stateDirectory, `${state.jobId}.json`);
    const original = fs.readFileSync(stateFile);
    fs.writeFileSync(stateFile, "{bad-json");
    await expect(advanceArchiveRelocation(state.jobId, { stateDirectory: f.stateDirectory }))
      .rejects.toThrow();
    expect(fs.existsSync(`${stateFile}.lock`)).toBe(false);
    fs.writeFileSync(stateFile, original);
    await expect(advanceArchiveRelocation(state.jobId, { stateDirectory: f.stateDirectory })).resolves.toBeDefined();
  });

  test("concurrent jobs cannot overwrite destination ownership", async () => {
    const f = fixture();
    const first = startArchiveRelocation(f.source, f.destination, { stateDirectory: f.stateDirectory });
    const second = startArchiveRelocation(f.source, f.destination, { stateDirectory: f.stateDirectory });
    const results = await Promise.allSettled([
      advanceArchiveRelocation(first.jobId, { stateDirectory: f.stateDirectory, maxFiles: 1 }),
      advanceArchiveRelocation(second.jobId, { stateDirectory: f.stateDirectory, maxFiles: 1 }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const owner = JSON.parse(fs.readFileSync(path.join(f.destination, ".archive-relocation-owner.json"), "utf8"));
    const winner = results[0]!.status === "fulfilled" ? first.jobId : second.jobId;
    expect(owner.jobId).toBe(winner);
  });

  test("ignores only known atomic transients and requires a fence to forget an uncopied disappearance", async () => {
    const f = fixture();
    const transient = path.join(f.source, "codex", "profile", `events.jsonl.tmp-12345678-1234-4123-8123-123456789abc`);
    fs.writeFileSync(transient, "partial");
    const unknown = path.join(f.source, "codex", "profile", "unknown-working-file");
    fs.writeFileSync(unknown, "temporary but unrecognized");
    let state = startArchiveRelocation(f.source, f.destination, { stateDirectory: f.stateDirectory });
    state = await advanceArchiveRelocation(state.jobId, { stateDirectory: f.stateDirectory, maxFiles: 1, maxBytes: 1 });
    expect(state.entries.some(entry => entry.relative.endsWith("tmp-12345678-1234-4123-8123-123456789abc"))).toBe(false);
    expect(state.entries.some(entry => entry.relative.endsWith("unknown-working-file"))).toBe(true);
    fs.unlinkSync(unknown);
    await expect(advanceArchiveRelocation(state.jobId, { stateDirectory: f.stateDirectory }))
      .rejects.toThrow("acknowledge an uncopied disappearance");
    state = await acknowledgeUncopiedRelocationDisappearance(state.jobId, {
      stateDirectory: f.stateDirectory,
      writerFence: { runWhileAllWritersFenced: operation => operation() },
    });
    expect(state.entries.some(entry => entry.relative.endsWith("unknown-working-file"))).toBe(false);
    expect(fs.existsSync(path.join(f.destination, "codex", "profile", path.basename(transient)))).toBe(false);
  });

  test("allows a parent state directory whose job files stay outside both roots", () => {
    const f = fixture();
    const state = startArchiveRelocation(f.source, f.destination, { stateDirectory: f.base });
    expect(readArchiveRelocation(f.base, state.jobId).jobId).toBe(state.jobId);
  });

  test("rejects an in-tree symlink without copying its external bytes", async () => {
    const f = fixture();
    const external = path.join(f.base, "external-secret.txt");
    const link = path.join(f.source, "codex", "profile", "linked.jsonl");
    fs.writeFileSync(external, "external");
    try {
      fs.symlinkSync(external, link, "file");
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    const state = startArchiveRelocation(f.source, f.destination, { stateDirectory: f.stateDirectory });
    await expect(advanceArchiveRelocation(state.jobId, { stateDirectory: f.stateDirectory }))
      .rejects.toThrow("Symlink or reparse-point source");
    expect(fs.existsSync(path.join(f.destination, "codex", "profile", "linked.jsonl"))).toBe(false);
  });
});
