import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PARSER_ASSET, PARSER_DIR, parserSourceHash, readParserRelease, releaseTag } from "../../scripts/dev/native-parser-version";

// Machines without Rust download the binary named in release.json (Rust R0). A parser change without a new
// release would leave them on an older binary, so the manifest must describe the current sources.
describe("native parser release", () => {
  test("release.json was published for the current parser sources", () => {
    const release = readParserRelease();
    expect(release).not.toBeNull();
    const hash = parserSourceHash();
    expect({ ...release!, repo: undefined }).toEqual({ source_hash: hash, tag: releaseTag(hash), repo: undefined, asset: PARSER_ASSET, sha256: release!.sha256 });
    expect(release!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(release!.repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
  });

  test("the version ignores line endings and covers every source file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parser-version-"));
    try {
      fs.mkdirSync(path.join(dir, "src", "nested"), { recursive: true });
      fs.writeFileSync(path.join(dir, "Cargo.toml"), "[package]\nname = \"x\"\n");
      fs.writeFileSync(path.join(dir, "Cargo.lock"), "# lock\n");
      fs.writeFileSync(path.join(dir, "src", "main.rs"), "fn main() {}\n");
      fs.writeFileSync(path.join(dir, "src", "nested", "a.rs"), "pub fn a() {}\n");
      const base = parserSourceHash(dir);
      fs.writeFileSync(path.join(dir, "src", "main.rs"), "fn main() {}\r\n");
      expect(parserSourceHash(dir)).toBe(base);
      fs.writeFileSync(path.join(dir, "src", "nested", "a.rs"), "pub fn a() { }\n");
      expect(parserSourceHash(dir)).not.toBe(base);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the hash reads the crate the build uses", () => {
    expect(fs.existsSync(path.join(PARSER_DIR, "Cargo.toml"))).toBe(true);
  });
});
