// Version of the native parser: SHA-256 over its build inputs (Cargo files, src/ and the release
// RUSTFLAGS), so a downloaded binary can be matched to the sources it was built from
// (docs/source-archive-plan-2026-09-19.md, Rust R0). Line endings are normalised: a Windows
// checkout and the machine that published the release must agree.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PARSER_DIR = path.resolve(import.meta.dir, "../../native/tokenatlas-parse");
export const PARSER_MANIFEST = path.join(PARSER_DIR, "release.json");
/** Portable build (decision 02.10): no CPU features of the publishing machine leak into the binary. */
export const PARSER_RUSTFLAGS = "-Ctarget-cpu=x86-64-v2";
export const PARSER_ASSET = "tokenatlas-parse-windows-x64.exe";

export interface ParserRelease {
  source_hash: string;
  tag: string;
  repo: string;
  asset: string;
  sha256: string;
}

function inputs(dir: string): string[] {
  const files = ["Cargo.toml", "Cargo.lock"];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  walk("src");
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function parserSourceHash(dir = PARSER_DIR): string {
  const hash = createHash("sha256").update(`rustflags:${PARSER_RUSTFLAGS}\n`);
  for (const rel of inputs(dir)) {
    const bytes = Buffer.from(fs.readFileSync(path.join(dir, rel)).toString("latin1").replace(/\r\n/g, "\n"), "latin1");
    hash.update(`${rel}\n${bytes.length}\n`).update(bytes);
  }
  return hash.digest("hex");
}

export const releaseTag = (sourceHash: string) => `parser-${sourceHash.slice(0, 12)}`;

export function readParserRelease(file = PARSER_MANIFEST): ParserRelease | null {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as ParserRelease : null;
}

// CLI for build-native-parser.ps1: `hash`, `rustflags`, `asset`, `tag`.
if (import.meta.main) {
  const what = process.argv[2] ?? "hash";
  const hash = parserSourceHash();
  const out = { hash, rustflags: PARSER_RUSTFLAGS, asset: PARSER_ASSET, tag: releaseTag(hash) }[what];
  if (out === undefined) { console.error(`unknown query: ${what}`); process.exit(2); }
  console.log(out);
}
