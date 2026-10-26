import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonicalArchivePath,
  physicalArchivePath,
  pinCanonicalArchiveRoot,
  readCanonicalArchiveRoot,
} from "./archive-paths";
import { resolveArchiveLogicalRootFromEnv, resolveConfigRootFromEnv } from "./paths";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-path-binding-"));
  roots.push(base);
  const original = path.join(base, "original");
  fs.mkdirSync(path.join(original, ".archive-inventory"), { recursive: true });
  fs.writeFileSync(path.join(original, ".archive-inventory", "identity.json"), JSON.stringify({ schema: 1, archiveId: "fixture-archive" }));
  return { base, original };
}

describe("archive logical/physical binding", () => {
  test("ordinary reads do not create binding metadata", () => {
    const { original } = fixture();
    expect(readCanonicalArchiveRoot(original)).toBeNull();
    expect(fs.existsSync(path.join(original, ".archive-inventory", "path-binding.json"))).toBe(false);
  });

  test("pin is immutable and copied metadata resolves a moved physical root", () => {
    const { base, original } = fixture();
    const pinned = pinCanonicalArchiveRoot(original);
    const moved = path.join(base, "moved");
    fs.cpSync(original, moved, { recursive: true });
    const reopened = readCanonicalArchiveRoot(moved)!;
    const logicalFile = path.join(original, "claude", "profile", "one.jsonl");
    const physicalFile = path.join(moved, "claude", "profile", "one.jsonl");
    expect(pinned.originalLogicalRoot).toBe(path.resolve(original));
    expect(reopened.originalLogicalRoot).toBe(path.resolve(original));
    expect(reopened.currentPhysicalRoot).toBe(path.resolve(moved));
    expect(canonicalArchivePath(reopened, physicalFile)).toBe(path.resolve(logicalFile));
    expect(physicalArchivePath(reopened, logicalFile)).toBe(path.resolve(physicalFile));
    expect(pinCanonicalArchiveRoot(moved).originalLogicalRoot).toBe(path.resolve(original));
  });

  test("dynamic env resolution rebases only archive-contained explicit config", () => {
    const { base, original } = fixture();
    pinCanonicalArchiveRoot(original);
    const moved = path.join(base, "moved");
    fs.cpSync(original, moved, { recursive: true });
    const external = path.join(base, "external-config");
    expect(resolveArchiveLogicalRootFromEnv({ TOKENATLAS_ARCHIVE: moved })).toBe(path.resolve(original));
    expect(resolveConfigRootFromEnv({ TOKENATLAS_ARCHIVE: moved, TOKENATLAS_CONFIG: path.join(original, "config") }))
      .toBe(path.join(path.resolve(moved), "config"));
    expect(resolveConfigRootFromEnv({ TOKENATLAS_ARCHIVE: moved, TOKENATLAS_CONFIG: external }))
      .toBe(path.resolve(external));
  });

  test("identity mismatch and invalid binding remain visible", () => {
    const { original } = fixture();
    pinCanonicalArchiveRoot(original);
    fs.writeFileSync(path.join(original, ".archive-inventory", "identity.json"), JSON.stringify({ schema: 1, archiveId: "different" }));
    expect(() => readCanonicalArchiveRoot(original)).toThrow("Invalid archive path binding");
    expect(() => resolveArchiveLogicalRootFromEnv({ TOKENATLAS_ARCHIVE: original })).toThrow("Invalid archive path binding");
  });
});
