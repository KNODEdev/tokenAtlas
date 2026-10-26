import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateQueuedJsonl } from "./adapters";
import { NativeParserError, ParsePool } from "../ingest/parse-pool";

test("parse workers reject the same queued files with the same messages, in input order", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-queued-jsonl-"));
  const previous = process.env.TOKENATLAS_PARSE_WORKERS;
  try {
    const files = Array.from({ length: 70 }, (_, index) => {
      const file = path.join(dir, `r${index}.jsonl`);
      fs.writeFileSync(file, `{"n":${index}}\n{"m":"${"x".repeat(index * 100)}"}\n`);
      return file;
    });
    fs.writeFileSync(files[5]!, '{"ok":1}\n{broken\n{"ok":2}\n');
    fs.writeFileSync(files[9]!, '{"ok":1}\n{"incomplete":');
    files.push(path.join(dir, "notes.txt"));
    const progress: number[] = [];
    process.env.TOKENATLAS_PARSE_WORKERS = "4";
    const parallel = await validateQueuedJsonl("codex", files, completed => progress.push(completed));
    process.env.TOKENATLAS_PARSE_WORKERS = "0";
    const inline = await validateQueuedJsonl("codex", files);
    expect(parallel).toEqual(inline);
    expect(parallel.filter(error => error !== undefined)).toHaveLength(2);
    expect(parallel[5]).toContain("Invalid JSONL record");
    expect(parallel[9]).toContain("incomplete JSONL record");
    expect(parallel[70]).toBeUndefined();
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(files.length);
  } finally {
    if (previous === undefined) delete process.env.TOKENATLAS_PARSE_WORKERS;
    else process.env.TOKENATLAS_PARSE_WORKERS = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex and Claude parsers reject the same files in their parsing read, with the same messages", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-parser-jsonl-"));
  const pool = new ParsePool(2);
  try {
    const contents = ['{"ok":1}\n', '{"ok":1}\n{broken\n{"ok":2}\n', '{"ok":1}\n{"incomplete":', '\uFEFF{"bom":1}\n', '{"s":"\ud800"}\n', '{"ok":1}\n{"last":2}'];
    for (const [index, content] of contents.entries()) {
      const file = path.join(dir, `f${index}.jsonl`);
      fs.writeFileSync(file, content);
      const expected = (await validateQueuedJsonl("codex", [file]))[0]?.replace(/^Error: /, "");
      const codex = await pool.run("codex", { file, size: fs.statSync(file).size, validate: true });
      expect(codex.kind === "read_error" ? codex.message : undefined).toBe(expected);
      const claude = await pool.run("claude", { store: "live", file, validate: true }).then(() => undefined, (error: Error) => {
        expect(error).toBeInstanceOf(NativeParserError);
        return error.message;
      });
      expect(claude).toBe(expected);
    }
  } finally {
    await pool.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing native parser fails the file instead of parsing it in TypeScript", async () => {
  const pool = new ParsePool(1, { binary: path.join(os.tmpdir(), "tokenatlas-no-such-parser.exe") });
  try {
    expect(pool.size).toBe(1);
    const error = await pool.run("codex", { file: "x.jsonl", size: 0 }).then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(NativeParserError);
    expect(String(error)).toContain("_dev.bat");
  } finally { await pool.close(); }
});
