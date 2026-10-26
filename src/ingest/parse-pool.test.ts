import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NativeParserError, OrderedPrefetch, ParsePool, ParseWorkerError, parseWorkerCount } from "./parse-pool";

function transcript(dir: string, name: string, lines: unknown[]): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join("\n") + "\n");
  return file;
}
const assistant = (id: string, output: number, timestamp: string) => ({
  type: "assistant", sessionId: "s1", timestamp, cwd: "C:/repo/app",
  message: { id, model: "claude-opus-5", stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: output } },
});

test("worker count is configurable and zero uses one native thread", () => {
  expect(parseWorkerCount({ TOKENATLAS_PARSE_WORKERS: "0" })).toBe(1);
  expect(parseWorkerCount({ TOKENATLAS_PARSE_WORKERS: "3" })).toBe(3);
  expect(parseWorkerCount({ TOKENATLAS_PARSE_WORKERS: "-1" })).toBeGreaterThanOrEqual(1);
  expect(parseWorkerCount({})).toBeLessThanOrEqual(8);
});

test("prefetch keeps a bounded window and hands each result to its own index", async () => {
  const started: number[] = [];
  const prefetch = new OrderedPrefetch([0, 1, 2, 3, 4, 5], 2, item => {
    if (item === 3) return undefined;
    started.push(item);
    return Promise.resolve(item * 10);
  });
  expect(await prefetch.take(0)).toBe(0);
  expect(started).toEqual([0, 1]);
  expect(await prefetch.take(1)).toBe(10);
  expect(await prefetch.take(2)).toBe(20);
  expect(prefetch.take(3)).toBeUndefined();
  expect(await prefetch.take(4)).toBe(40);
  expect(await prefetch.take(5)).toBe(50);
  expect(started).toEqual([0, 1, 2, 4, 5]);
});

test("native workers preserve streaming calls and reports file errors as such", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-parse-pool-"));
  const pool = new ParsePool(2);
  try {
    expect(pool.size).toBe(2);
    const file = transcript(dir, "session.jsonl", [
      assistant("msg_1", 5, "2026-09-01T10:00:00.000Z"),
      assistant("msg_1", 9, "2026-09-01T10:00:02.000Z"),
      { ...assistant("msg_2", 4, "2026-09-01T10:01:00.000Z"), cwd: "C:/repo/\u2028other" },
    ]);

    const [first, second] = await Promise.all([
      pool.run("claude", { store: "live", file }), pool.run("claude", { store: "live", file })]);
    expect(first.limitHits).toEqual([]);
    expect(first.events.map(event => event.out_total)).toEqual([9, 4]);
    expect(second).toEqual(first);
    const missing = pool.run("claude", { store: "live", file: path.join(dir, "missing.jsonl") });
    const error = await missing.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ParseWorkerError);
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
  } finally {
    await pool.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a closed pool refuses work", async () => {
  const pool = new ParsePool(1);
  await pool.close();
  const error = await pool.run("claude", { store: "live", file: "unused.jsonl" }).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(ParseWorkerError);
});

test("a native crash fails only the file that causes it; the restarted parser takes the others", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-native-crash-"));
  const binary = path.join(dir, process.platform === "win32" ? "fake-parser.exe" : "fake-parser");
  // Speaks the native frame protocol; exits on the file named "crash", answers the rest late
  // enough that several requests are in flight at the crash.
  fs.writeFileSync(path.join(dir, "fake.ts"), `
    let buffer = Buffer.alloc(0);
    process.stdin.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const length = buffer.readUInt32LE(0), request = JSON.parse(buffer.subarray(4, 4 + length).toString());
        buffer = buffer.subarray(4 + length);
        if (request.input.file === "crash") setTimeout(() => process.exit(3), 30);
        else setTimeout(() => {
          const body = Buffer.from(JSON.stringify({ id: request.id, ok: true, value: { kind: "read_error", errno: 0, message: request.input.file, code: null } }));
          const frame = Buffer.alloc(4); frame.writeUInt32LE(body.length);
          process.stdout.write(Buffer.concat([frame, body]));
        }, 60);
      }
    });`);
  const build = Bun.spawnSync([process.execPath, "build", "--compile", path.join(dir, "fake.ts"), "--outfile", binary], { stdout: "ignore", stderr: "pipe" });
  expect(build.exitCode).toBe(0);
  const pool = new ParsePool(2, { binary });
  try {
    const files = ["a", "b", "crash", "c", "d"];
    const results = await Promise.all(files.map(file => pool.run("codex", { file, size: 0 })
      .then(value => value.kind === "read_error" ? value.message : "?", (error: unknown) => error)));
    expect(results.filter(result => result instanceof NativeParserError)).toHaveLength(1);
    expect(results[2]).toBeInstanceOf(NativeParserError);
    expect(results.filter((_, index) => index !== 2)).toEqual(["a", "b", "c", "d"]);
  } finally {
    await pool.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
