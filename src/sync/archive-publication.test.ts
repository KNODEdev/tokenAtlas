import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeTestFixture } from "../test-cleanup";
import { ensureArchiveIdentity } from "./archive-inventory";
import {
  ArchivePublicationConflictError,
  archivePublicationIsCurrent,
  archivePublicationPaths,
  publishArchiveFile,
} from "./archive-publication";
import { isRecoverableArchiveSource } from "./archive-source-path";
import { SyncFileQueue, acceptedArchiveFingerprint } from "./file-queue";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeTestFixture(root, { recursive: true, force: true });
});

function fixture(extension = "jsonl") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-publication-"));
  roots.push(root);
  const archiveRoot = path.join(root, "archive");
  const localStateRoot = path.join(root, "local-state");
  const source = path.join(root, `source.${extension}`);
  const destination = path.join(archiveRoot, extension === "jsonl"
    ? "claude/machine/session.jsonl" : "opencode/machine/opencode.sqlite");
  fs.mkdirSync(archiveRoot);
  ensureArchiveIdentity(archiveRoot);
  const options = { archiveRoot, localStateRoot, jsonl: extension === "jsonl" };
  const publish = () => publishArchiveFile(source, destination, options);
  return { root, archiveRoot, localStateRoot, source, destination, options, publish };
}

describe("ordinary archive publication", () => {
  test("first read of an existing archive tolerates hydration-only attribute changes", () => {
    const f = fixture();
    fs.writeFileSync(f.source, '{"first":1}\n{"second":2}\n');
    fs.mkdirSync(path.dirname(f.destination), { recursive: true });
    fs.writeFileSync(f.destination, '{"first":1}\n');
    const lstat = fs.lstatSync.bind(fs);
    let observations = 0;
    const spy = spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, options: unknown) => {
      const stat = (lstat as Function)(file, options);
      if (String(file) === f.destination && typeof stat.ctimeNs === "bigint") {
        stat.ctimeNs += BigInt(++observations);
      }
      return stat;
    }) as typeof fs.lstatSync);
    try { expect(f.publish()).toBe("copied"); }
    finally { spy.mockRestore(); }
    expect(observations).toBeGreaterThan(2);
    expect(fs.readFileSync(f.destination)).toEqual(fs.readFileSync(f.source));
    expect(f.publish()).toBe("unchanged");
  });

  test("a same-size content rewrite during archive inspection is still rejected", () => {
    const f = fixture();
    fs.writeFileSync(f.source, '{"first":1}\n{"second":2}\n');
    fs.mkdirSync(path.dirname(f.destination), { recursive: true });
    fs.writeFileSync(f.destination, '{"first":1}\n');
    const open = fs.openSync.bind(fs);
    let changed = false;
    const spy = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
      if (String(file) === f.destination && !changed) {
        changed = true;
        fs.writeFileSync(f.destination, '{"first":9}\n');
        fs.utimesSync(f.destination, new Date(), new Date("2026-01-01"));
      }
      return (open as Function)(file, ...args);
    }) as typeof fs.openSync);
    try { expect(f.publish).toThrow("Archive destination changed while reading"); }
    finally { spy.mockRestore(); }
    expect(fs.readFileSync(f.destination, "utf8")).toBe('{"first":9}\n');
    expect(f.publish).toThrow(ArchivePublicationConflictError);
  });

  test("three appends update one ordinary source and restart/no-op never creates a version store", () => {
    const f = fixture();
    for (let index = 1; index <= 3; index++) {
      fs.appendFileSync(f.source, `${JSON.stringify({ index })}\n`);
      expect(f.publish()).toBe("copied");
    }
    const accepted = fs.readFileSync(f.destination);
    const modified = fs.statSync(f.destination).mtimeMs;
    expect(f.publish()).toBe("unchanged");
    expect(fs.statSync(f.destination).mtimeMs).toBe(modified);
    expect(archivePublicationIsCurrent(f.archiveRoot, f.destination, { localStateRoot: f.localStateRoot })).toBe(true);
    expect(fs.readdirSync(path.dirname(f.destination))).toEqual(["session.jsonl"]);
    expect(fs.existsSync(path.join(f.archiveRoot, ".source-versions"))).toBe(false);

    const modulePath = path.resolve(import.meta.dir, "archive-publication.ts");
    const code = `import {publishArchiveFile} from ${JSON.stringify(modulePath)};
      const result=publishArchiveFile(${JSON.stringify(f.source)},${JSON.stringify(f.destination)},${JSON.stringify(f.options)});
      if(result!=="unchanged")throw new Error(result);`;
    const child = Bun.spawnSync([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe" });
    expect({ exit: child.exitCode, error: child.stderr.toString() }).toEqual({ exit: 0, error: "" });
    expect(fs.readFileSync(f.destination)).toEqual(accepted);
  });

  test("a vanished accepted JSONL is restored only from its complete original prefix", () => {
    const f=fixture(),accepted='{"one":1}\n{"two":2}\n';
    fs.writeFileSync(f.source,accepted);expect(f.publish()).toBe("copied");
    const state=archivePublicationPaths(f.archiveRoot,f.destination,{localStateRoot:f.localStateRoot}).state;
    const proof=fs.readFileSync(state);
    fs.rmSync(f.destination);
    fs.writeFileSync(f.source,'{"one":1}\n');
    expect(f.publish).toThrow("cannot prove its accepted prefix");
    expect(fs.existsSync(f.destination)).toBe(false);
    expect(fs.readFileSync(state)).toEqual(proof);
    fs.writeFileSync(f.source,accepted);
    expect(f.publish()).toBe("copied");
    expect(fs.readFileSync(f.destination,"utf8")).toBe(accepted);
  });

  test("accepted queue evidence blocks missing JSONL recreation after its local checkpoint is lost", () => {
    const f=fixture();fs.writeFileSync(f.source,'{"one":1}\n{"two":2}\n');
    f.publish();
    const queue=new SyncFileQueue(f.archiveRoot,f.localStateRoot);
    try {queue.acknowledge([queue.observe(f.destination,"claude")]);}finally{queue.close();}
    const state=archivePublicationPaths(f.archiveRoot,f.destination,{localStateRoot:f.localStateRoot}).state;
    const proof=acceptedArchiveFingerprint(f.archiveRoot,f.destination,f.localStateRoot);
    expect(proof).toBeTruthy();
    fs.rmSync(state);fs.rmSync(f.destination);
    fs.writeFileSync(f.source,'{"one":1}\n');
    expect(f.publish).toThrow("previously accepted bytes have no publication checkpoint");
    expect(fs.existsSync(f.destination)).toBe(false);
    expect(acceptedArchiveFingerprint(f.archiveRoot,f.destination,f.localStateRoot)).toBe(proof);
  });

  test("shorter or deleted originals never truncate accepted bytes", () => {
    const f = fixture();
    fs.writeFileSync(f.source, '{"one":1}\n{"two":2}\n');
    expect(f.publish()).toBe("copied");
    const accepted = fs.readFileSync(f.destination);
    fs.writeFileSync(f.source, '{"one":1}\n');
    expect(f.publish()).toBe("unchanged");
    expect(fs.readFileSync(f.destination)).toEqual(accepted);
    fs.unlinkSync(f.source);
    expect(f.publish).toThrow("source disappeared");
    expect(fs.readFileSync(f.destination)).toEqual(accepted);
  });

  test("a divergent rewrite preserves accepted bytes and one excluded conflict copy", () => {
    const f = fixture();
    fs.writeFileSync(f.source, '{"accepted":1}\n');
    f.publish();
    const accepted = fs.readFileSync(f.destination);
    fs.writeFileSync(f.source, '{"different":2}\n');
    let conflict: ArchivePublicationConflictError | undefined;
    try { f.publish(); }
    catch (error) { conflict = error as ArchivePublicationConflictError; }
    expect(conflict).toBeInstanceOf(ArchivePublicationConflictError);
    expect(conflict!.message).toContain("Unresolved archive source conflict");
    expect(fs.readFileSync(f.destination)).toEqual(accepted);
    expect(fs.readFileSync(conflict!.conflictFile)).toEqual(fs.readFileSync(f.source));
    expect(path.dirname(conflict!.conflictFile)).toBe(path.dirname(f.destination));
    expect(isRecoverableArchiveSource(`claude/machine/${path.basename(conflict!.conflictFile)}`)).toBe(false);
    expect(() => f.publish()).toThrow(ArchivePublicationConflictError);
    expect(fs.readdirSync(path.dirname(f.destination)).filter(name => name.includes(".conflict-"))).toHaveLength(1);
    for(let index=0;index<3;index++) {
      fs.appendFileSync(f.source,JSON.stringify({index})+"\n");
      expect(()=>f.publish()).toThrow(ArchivePublicationConflictError);
    }
    expect(fs.readdirSync(path.dirname(f.destination)).filter(name=>name.includes(".conflict-"))).toHaveLength(1);
    expect(fs.readFileSync(conflict!.conflictFile)).toEqual(fs.readFileSync(f.source));
    expect(fs.readFileSync(f.destination)).toEqual(accepted);
  });

  test("append verifies the accepted prefix without rereading the unchanged archive",()=>{
    const f=fixture();fs.writeFileSync(f.source,'{"first":1}\n');f.publish();
    fs.appendFileSync(f.source,'{"second":2}\n');
    const open=fs.openSync.bind(fs);
    const spy=spyOn(fs,"openSync").mockImplementation(((file:fs.PathLike,...args:unknown[])=>{
      if(String(file)===f.destination)throw new Error("unchanged archive content was reread");
      return (open as Function)(file,...args);
    }) as typeof fs.openSync);
    try{expect(f.publish()).toBe("copied");}finally{spy.mockRestore();}
    expect(fs.readFileSync(f.destination,"utf8")).toBe('{"first":1}\n{"second":2}\n');
    fs.writeFileSync(f.source,'{"first":9}\n{"second":2}\n{"third":3}\n');
    expect(()=>f.publish()).toThrow(ArchivePublicationConflictError);
  });

  test("partial JSONL tails wait for a complete record without whole-file reads", () => {
    const f = fixture();
    fs.writeFileSync(f.source, '{"first":1}\n{"second":');
    const originalRead = fs.readFileSync.bind(fs);
    const read = spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (String(file) === f.source || String(file) === f.destination) throw new Error("whole transcript read");
      return (originalRead as Function)(file, ...args);
    }) as typeof fs.readFileSync);
    // Restore before assertions that intentionally use readFileSync.
    try { expect(f.publish()).toBe("copied"); }
    finally { read.mockRestore(); }
    expect(fs.readFileSync(f.destination, "utf8")).toBe('{"first":1}\n');
    fs.appendFileSync(f.source, "2}\n");
    expect(f.publish()).toBe("copied");
    expect(fs.readFileSync(f.destination, "utf8")).toBe('{"first":1}\n{"second":2}\n');

    const empty = fixture();
    fs.writeFileSync(empty.source, '{"only":');
    expect(empty.publish).toThrow("publication deferred");
    expect(fs.existsSync(empty.destination)).toBe(false);
  });

  test("local checkpoint failure keeps the accepted archive and retry reconstructs state", () => {
    const f = fixture();
    fs.writeFileSync(f.source, '{"first":1}\n');
    f.publish();
    fs.appendFileSync(f.source, '{"second":2}\n');
    const state = archivePublicationPaths(f.archiveRoot, f.destination, { localStateRoot: f.localStateRoot }).state;
    const rename = fs.renameSync.bind(fs);
    const failure = spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === state) throw new Error("local state unavailable");
      return rename(from, to);
    }) as typeof fs.renameSync);
    try { expect(f.publish).toThrow("local state unavailable"); }
    finally { failure.mockRestore(); }
    expect(fs.readFileSync(f.destination, "utf8")).toBe('{"first":1}\n{"second":2}\n');
    expect(f.publish()).toBe("unchanged");
    expect(archivePublicationIsCurrent(f.archiveRoot, f.destination, { localStateRoot: f.localStateRoot })).toBe(true);
    expect(fs.existsSync(path.join(f.archiveRoot, ".source-versions"))).toBe(false);
  });

  test("opaque rewrites are explicit conflicts rather than invented appends", () => {
    const f = fixture("sqlite");
    fs.writeFileSync(f.source, Buffer.from([1, 2, 3]));
    expect(f.publish()).toBe("copied");
    fs.writeFileSync(f.source, Buffer.from([1, 2, 3, 4]));
    expect(f.publish).toThrow(ArchivePublicationConflictError);
    expect(fs.readFileSync(f.destination)).toEqual(Buffer.from([1, 2, 3]));
  });
});

describe("provider log rewritten in place", () => {
  // Shapes taken from the real Codex legacy -> paginated migration on 2026-09-19.
  const usage = (turn: string) => ({
    type: "token_usage_record",
    payload: { turn_id: turn, info: { total_token_usage: { input_tokens: 10, output_tokens: 2 } } },
  });
  const record = (value: unknown) => JSON.stringify(value) + "\n";
  const legacy = (turn: string) =>
    record({ timestamp: "2026-09-16T15:31:29.816Z", type: "session_meta", payload: { history_mode: "legacy" } })
    + record({ timestamp: "2026-09-16T15:31:30.000Z", type: "event_msg", payload: { type: "agent_message", message: turn } })
    + record({ timestamp: "2026-09-16T15:31:31.000Z", ...usage(turn) });
  const paginated = (turns: string[]) => turns.map((turn, index) =>
    record({ timestamp: "2026-09-16T15:31:29.816Z", ordinal: index * 3, type: "session_meta",
      payload: { history_mode: "paginated", subagent_history_start_ordinal: 0 } })
    + record({ timestamp: "2026-09-16T15:31:30.000Z", ordinal: index * 3 + 1, type: "event_msg",
      payload: { type: "item_completed", thread_id: "t", item: { type: "AgentMessage", content: turn } } })
    + record({ timestamp: "2026-09-16T15:31:31.000Z", ordinal: index * 3 + 2, ...usage(turn) })).join("");
  function codexFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-publication-"));
    roots.push(root);
    const archiveRoot = path.join(root, "archive");
    const source = path.join(root, "rollout.jsonl");
    const destination = path.join(archiveRoot, "codex/machine/sessions/2026/09/16/rollout.jsonl");
    fs.mkdirSync(archiveRoot);
    ensureArchiveIdentity(archiveRoot);
    const options = { archiveRoot, localStateRoot: path.join(root, "local-state"), jsonl: true };
    return { archiveRoot, source, destination, publish: () => publishArchiveFile(source, destination, options) };
  }
  const beside = (destination: string, marker: string) =>
    fs.readdirSync(path.dirname(destination)).filter((name) => name.includes(marker));

  test("a re-encoding that keeps every accounted record is adopted and the replaced reading is kept", () => {
    const f = codexFixture();
    fs.writeFileSync(f.source, legacy("one"));
    expect(f.publish()).toBe("copied");
    const acceptedBytes = fs.readFileSync(f.destination);
    fs.writeFileSync(f.source, paginated(["one"]));
    expect(f.publish()).toBe("copied");
    expect(fs.readFileSync(f.destination, "utf8")).toBe(paginated(["one"]));
    expect(beside(f.destination, ".conflict-")).toEqual([]);
    const kept = beside(f.destination, ".superseded-");
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(f.destination), kept[0]!))).toEqual(acceptedBytes);
    // The adopted reading is the accepted one from now on, so an append still applies.
    fs.writeFileSync(f.source, paginated(["one", "two"]));
    expect(f.publish()).toBe("copied");
    expect(beside(f.destination, ".conflict-")).toEqual([]);
    expect(beside(f.destination, ".superseded-")).toHaveLength(1);
  });

  test("a rewrite that drops accounted records stays a conflict and never replaces the archive", () => {
    const f = codexFixture();
    fs.writeFileSync(f.source, legacy("one") + legacy("two") + legacy("three"));
    expect(f.publish()).toBe("copied");
    const accepted = fs.readFileSync(f.destination, "utf8");
    // The paginated rewrite stops materialising the earlier turns inline.
    fs.writeFileSync(f.source, paginated(["three"]));
    expect(() => f.publish()).toThrow(ArchivePublicationConflictError);
    expect(fs.readFileSync(f.destination, "utf8")).toBe(accepted);
    expect(beside(f.destination, ".conflict-")).toHaveLength(1);
    expect(beside(f.destination, ".superseded-")).toEqual([]);
  });

  test("another vendor keeps the strict prefix rule", () => {
    const f = fixture();
    fs.writeFileSync(f.source, JSON.stringify({ type: "token_usage_record", payload: { turn_id: "one" } }) + "\n");
    expect(f.publish()).toBe("copied");
    fs.writeFileSync(f.source,
      JSON.stringify({ ordinal: 0, type: "token_usage_record", payload: { turn_id: "one" } }) + "\n"
      + JSON.stringify({ ordinal: 1, type: "token_usage_record", payload: { turn_id: "two" } }) + "\n");
    expect(() => f.publish()).toThrow(ArchivePublicationConflictError);
  });
});

describe("a divergence the archive already holds", () => {
  const line = (id: string) => JSON.stringify({ id }) + String.fromCharCode(10);

  test("is raised as already recorded once the same bytes are on file", () => {
    const f = fixture();
    fs.writeFileSync(f.source, line("one"));
    expect(f.publish()).toBe("copied");
    const accepted = fs.readFileSync(f.destination, "utf8");
    fs.writeFileSync(f.source, line("other"));
    let first: ArchivePublicationConflictError | undefined;
    try { f.publish(); } catch (error) { first = error as ArchivePublicationConflictError; }
    expect(first?.alreadyRecorded).toBe(false);
    let repeated: ArchivePublicationConflictError | undefined;
    try { f.publish(); } catch (error) { repeated = error as ArchivePublicationConflictError; }
    expect(repeated?.alreadyRecorded).toBe(true);
    expect(fs.readFileSync(f.destination, "utf8")).toBe(accepted);
    // A source that diverges further is a new state, raised as such.
    fs.writeFileSync(f.source, line("other") + line("more"));
    let extended: ArchivePublicationConflictError | undefined;
    try { f.publish(); } catch (error) { extended = error as ArchivePublicationConflictError; }
    expect(extended?.alreadyRecorded).toBe(false);
    expect(fs.readdirSync(path.dirname(f.destination)).filter((name) => name.includes(".conflict-"))).toHaveLength(1);
    expect(fs.readFileSync(f.destination, "utf8")).toBe(accepted);
  });

  test("a rewrite with nothing accounted in the accepted reading is adopted", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-publication-"));
    roots.push(root);
    const archiveRoot = path.join(root, "archive");
    const source = path.join(root, "rollout.jsonl");
    const destination = path.join(archiveRoot, "codex/machine/sessions/2026/09/16/rollout.jsonl");
    fs.mkdirSync(archiveRoot);
    ensureArchiveIdentity(archiveRoot);
    const options = { archiveRoot, localStateRoot: path.join(root, "local-state"), jsonl: true };
    const publish = () => publishArchiveFile(source, destination, options);
    const meta = (mode: string, ordinal?: number) =>
      JSON.stringify({ type: "session_meta", ...(ordinal === undefined ? {} : { ordinal }), payload: { history_mode: mode } }) + "\n";
    fs.writeFileSync(source, meta("legacy") + JSON.stringify({ type: "event_msg", payload: { message: "hi" } }) + "\n");
    expect(publish()).toBe("copied");
    const previous = fs.readFileSync(destination);
    const rewritten = meta("paginated", 0)
      + JSON.stringify({ type: "event_msg", ordinal: 1, payload: { type: "item_completed", item: { content: "hi" } } }) + "\n";
    fs.writeFileSync(source, rewritten);
    expect(publish()).toBe("copied");
    expect(fs.readFileSync(destination, "utf8")).toBe(rewritten);
    const kept = fs.readdirSync(path.dirname(destination)).filter((name) => name.includes(".superseded-"));
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(destination), kept[0]!))).toEqual(previous);
  });
});

describe("archive copies without local publication state", () => {
  /** Opens per path while `work` runs: each file read once is opened once. */
  function opens(work: () => unknown): Map<string, number> {
    const counts = new Map<string, number>(), original = fs.openSync;
    const spy = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
      const key = path.resolve(String(file));
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return Reflect.apply(original, fs, [file, ...args]);
    }) as typeof fs.openSync);
    try { work(); } finally { spy.mockRestore(); }
    return counts;
  }
  const lines = (count: number) => Array.from({ length: count }, (_, index) => JSON.stringify({ record: index })).join("\n") + "\n";

  test("a copy equal to its original is accepted with one read of each file, then by metadata", () => {
    const f = fixture();
    fs.writeFileSync(f.source, lines(3));
    fs.mkdirSync(path.dirname(f.destination), { recursive: true });
    fs.writeFileSync(f.destination, lines(3));
    const first = opens(() => expect(f.publish()).toBe("unchanged"));
    expect([first.get(path.resolve(f.source)), first.get(path.resolve(f.destination))]).toEqual([1, 1]);
    expect(archivePublicationIsCurrent(f.archiveRoot, f.destination, { localStateRoot: f.localStateRoot })).toBe(true);
    const second = opens(() => expect(f.publish()).toBe("unchanged"));
    expect([second.get(path.resolve(f.source)), second.get(path.resolve(f.destination))]).toEqual([undefined, undefined]);
  });

  test("a grown original extends the copy; its accepted prefix is compared, not reparsed", () => {
    const f = fixture();
    fs.writeFileSync(f.source, lines(5));
    fs.mkdirSync(path.dirname(f.destination), { recursive: true });
    fs.writeFileSync(f.destination, lines(3));
    expect(f.publish()).toBe("copied");
    expect(fs.readFileSync(f.destination, "utf8")).toBe(lines(5));
    expect(f.publish()).toBe("unchanged");
    // The state written for the grown copy carries on as ordinary appends.
    fs.appendFileSync(f.source, JSON.stringify({ record: 5 }) + "\n");
    expect(f.publish()).toBe("copied");
    expect(fs.readFileSync(f.destination, "utf8")).toBe(lines(6));
  });

  test("a shorter or diverging original never shortens or replaces the copy", () => {
    const shorter = fixture();
    fs.writeFileSync(shorter.source, lines(2));
    fs.mkdirSync(path.dirname(shorter.destination), { recursive: true });
    fs.writeFileSync(shorter.destination, lines(3));
    expect(shorter.publish()).toBe("unchanged");
    expect(fs.readFileSync(shorter.destination, "utf8")).toBe(lines(3));
    const diverging = fixture();
    fs.writeFileSync(diverging.source, lines(3).replace('"record":1', '"record":9'));
    fs.mkdirSync(path.dirname(diverging.destination), { recursive: true });
    fs.writeFileSync(diverging.destination, lines(3));
    expect(() => diverging.publish()).toThrow(ArchivePublicationConflictError);
    expect(fs.readFileSync(diverging.destination, "utf8")).toBe(lines(3));
  });
});
