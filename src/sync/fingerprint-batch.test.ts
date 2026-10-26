import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fingerprint } from "./file-fingerprint";
import { SyncFileQueue } from "./file-queue";
import { fingerprintAll } from "./fingerprint-batch";

test("a large batch hashed by workers equals hashing each file here, in input order", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-fingerprints-"));
  const previous = process.env.TOKENATLAS_PARSE_WORKERS;
  try {
    const files = Array.from({ length: 80 }, (_, index) => {
      const file = path.join(dir, `f${index}.jsonl`);
      fs.writeFileSync(file, `{"n":${index}}\n`.repeat(index + 1));
      return file;
    });
    files.splice(40, 0, path.join(dir, "missing.jsonl"));
    process.env.TOKENATLAS_PARSE_WORKERS = "4";
    const parallel = fingerprintAll(files);
    expect(parallel).toEqual(files.map(file => ({ fingerprint: fingerprint(file) })));
    expect(parallel[40]).toEqual({ fingerprint: "missing" });
    process.env.TOKENATLAS_PARSE_WORKERS = "0";
    expect(fingerprintAll(files)).toEqual(parallel);
  } finally {
    if (previous === undefined) delete process.env.TOKENATLAS_PARSE_WORKERS;
    else process.env.TOKENATLAS_PARSE_WORKERS = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a file that is not ordinary reports the same error through the batch", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-fingerprints-"));
  const previous = process.env.TOKENATLAS_PARSE_WORKERS;
  try {
    const files = Array.from({ length: 70 }, (_, index) => {
      const file = path.join(dir, `f${index}.jsonl`);
      fs.writeFileSync(file, "x\n");
      return file;
    });
    const directory = path.join(dir, "folder.jsonl");
    fs.mkdirSync(directory);
    files.push(directory);
    process.env.TOKENATLAS_PARSE_WORKERS = "4";
    const [last] = fingerprintAll(files).slice(-1);
    expect(last).toEqual({ error: `Queued input is not an ordinary file: ${directory}` });
  } finally {
    if (previous === undefined) delete process.env.TOKENATLAS_PARSE_WORKERS;
    else process.env.TOKENATLAS_PARSE_WORKERS = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parallel queue verification detects same-size rewrites and retains unpublished work across restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-fingerprints-"));
  const archive = path.join(dir, "archive"), state = path.join(dir, "state");
  fs.mkdirSync(archive);
  const roots = [{path:archive,vendor:"claude",kind:"archive"}] as const;
  let queue = new SyncFileQueue(archive, state);
  const previous = process.env.TOKENATLAS_PARSE_WORKERS;
  try {
    process.env.TOKENATLAS_PARSE_WORKERS = "4";
    const files = Array.from({length:80}, (_, index) => {
      const file=path.join(archive, `${index}.jsonl`);fs.writeFileSync(file,"old");return file;
    });
    queue.prepare([...roots]);
    const selected=queue.take("claude",[...roots]);
    queue.acknowledge(selected.slice(1));
    queue.close();queue=new SyncFileQueue(archive,state);
    expect(queue.take("claude",[...roots]).map(row=>row.path)).toEqual([files[0]!]);
    queue.acknowledge(queue.take("claude",[...roots]));
    const rewritten=files[1]!, before=fs.statSync(rewritten);
    fs.writeFileSync(rewritten,"new");fs.utimesSync(rewritten,before.atime,before.mtime);
    for(const file of files)queue.enqueue(file,"claude");
    const correction=queue.take("claude",[...roots]);
    expect(correction.map(row=>row.path)).toEqual([rewritten]);
    fs.writeFileSync(rewritten,"again");
    expect(queue.acknowledge(correction)).toHaveLength(1);
    expect(queue.hasPending("claude",rewritten)).toBe(true);
    queue.revisit(files[2]!,"claude");
    expect(queue.take("claude",[...roots]).map(row=>row.path).sort()).toEqual([rewritten,files[2]!].sort());
  } finally {
    queue.close();
    if(previous===undefined)delete process.env.TOKENATLAS_PARSE_WORKERS;else process.env.TOKENATLAS_PARSE_WORKERS=previous;
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
