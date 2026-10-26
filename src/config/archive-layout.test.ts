import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ARCHIVE_LAYOUT_FILE,
  LEGACY_ARCHIVE_FOLDERS,
  archiveLayoutLogicalPath,
  archiveLayoutPhysicalPath,
  archiveLayoutSourceStore,
  isLegacyArchiveProfile,
  readArchiveLayout,
  type ArchiveLayout,
  validateArchiveLayout,
} from "../../scripts/migrations/archive-layout";

const roots: string[] = [];
const archiveId = "fixture-archive";
const jobId = "123e4567-e89b-42d3-a456-426614174000";

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(overrides: Partial<ArchiveLayout> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-archive-layout-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".archive-inventory"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".archive-inventory", "identity.json"),
    JSON.stringify({ schema: 1, archiveId }),
  );
  const layout: ArchiveLayout = {
    schema: 1,
    archiveId,
    jobId,
    phase: "complete",
    entries: LEGACY_ARCHIVE_FOLDERS.map(entry => ({ ...entry })),
    ...overrides,
  };
  fs.writeFileSync(path.join(root, ARCHIVE_LAYOUT_FILE), JSON.stringify(layout));
  return { root, layout };
}

function schema2Layout(overrides: Partial<ArchiveLayout> = {}): ArchiveLayout {
  return {
    schema: 2,
    archiveId,
    jobId,
    phase: "complete",
    entries: [{ logical: "projects", physical: "claude/PC", store: "hub" }],
    files: [{ logical: "projects/a.jsonl", physical: "claude/PC/a.jsonl" }],
    ...overrides,
  };
}

function schema2Fixture(overrides: Partial<ArchiveLayout> = {}) {
  return fixture(schema2Layout(overrides));
}

describe("archive source layout", () => {
  test("round-trips both legacy logical prefixes through their physical targets", () => {
    const { root } = fixture();
    for (const entry of LEGACY_ARCHIVE_FOLDERS) {
      const logical = path.join(root, entry.logical, "session", "usage.jsonl");
      const physical = path.join(root, entry.physical, "session", "usage.jsonl");
      expect(archiveLayoutPhysicalPath(root, logical)).toBe(physical);
      expect(archiveLayoutLogicalPath(root, physical)).toBe(logical);
    }
  });

  test("does not rewrite a prefix extension or an external path", () => {
    const { root } = fixture();
    const logicalExtension = path.join(root, "projects-copy", "usage.jsonl");
    const physicalExtension = path.join(root, "claude", "legacy-projects-copy", "usage.jsonl");
    const external = path.resolve(root, "..", "outside", "projects", "usage.jsonl");
    expect(archiveLayoutPhysicalPath(root, logicalExtension)).toBe(logicalExtension);
    expect(archiveLayoutLogicalPath(root, physicalExtension)).toBe(physicalExtension);
    expect(archiveLayoutPhysicalPath(root, external)).toBe(external);
    expect(archiveLayoutLogicalPath(root, external)).toBe(external);
  });

  test("refuses reads while a layout migration is pending", () => {
    const { root } = fixture({ phase: "moving" });
    expect(() => readArchiveLayout(root)).toThrow("Archive source layout migration is unfinished");
    expect(() => archiveLayoutPhysicalPath(root, path.join(root, "projects", "usage.jsonl")))
      .toThrow("Archive source layout migration is unfinished");
  });

  test("rejects duplicate layout entries", () => {
    const { root } = fixture({ entries: [
      { ...LEGACY_ARCHIVE_FOLDERS[0] },
      { ...LEGACY_ARCHIVE_FOLDERS[0] },
    ] });
    expect(() => readArchiveLayout(root)).toThrow("Invalid archive source layout");
  });

  test("rejects layout metadata belonging to another archive identity", () => {
    const { root } = fixture({ archiveId: "different-archive" });
    expect(() => readArchiveLayout(root)).toThrow("Invalid archive source layout");
  });

  test("marks only migrated physical profiles as legacy archive profiles", () => {
    const { root } = fixture();
    expect(isLegacyArchiveProfile(root, "claude", "legacy-projects")).toBe(true);
    expect(isLegacyArchiveProfile(root, "claude", "legacy-projectAsus")).toBe(true);
    expect(isLegacyArchiveProfile(root, "claude", "fixture-machine")).toBe(false);
    expect(isLegacyArchiveProfile(root, "projects", "legacy-projects")).toBe(false);
  });

  test("maps an exact migrated transcript and keeps an ordinary merged profile live", () => {
    const { root } = schema2Fixture();
    const logical = path.join(root, "projects", "a.jsonl");
    const physical = path.join(root, "claude", "PC", "a.jsonl");
    const ordinary = path.join(root, "claude", "PC", "new.jsonl");

    expect(archiveLayoutPhysicalPath(root, logical)).toBe(physical);
    expect(archiveLayoutLogicalPath(root, physical)).toBe(logical);
    expect(archiveLayoutSourceStore(root, physical)).toBe("hub");
    expect(archiveLayoutPhysicalPath(root, ordinary)).toBe(ordinary);
    expect(archiveLayoutLogicalPath(root, ordinary)).toBe(ordinary);
    expect(archiveLayoutSourceStore(root, ordinary)).toBe("live");
    expect(isLegacyArchiveProfile(root, "claude", "PC")).toBe(false);
  });

  test("maps a retained non-JSONL source to its content-addressed blob", () => {
    const digest = "a".repeat(64);
    const { root } = schema2Fixture({ files: [{ logical: "projects/state.sqlite", physical: `.source-versions/blobs/${digest}` }] });
    const logical = path.join(root, "projects", "state.sqlite");
    const blob = path.join(root, ".source-versions", "blobs", digest);

    expect(archiveLayoutPhysicalPath(root, logical)).toBe(blob);
    expect(archiveLayoutLogicalPath(root, blob)).toBe(blob);
  });

  test("rejects a JSONL source mapped to a retained blob", () => {
    const digest = "b".repeat(64);
    const layout = schema2Layout({ files: [{ logical: "projects/a.jsonl", physical: `.source-versions/blobs/${digest}` }] });
    expect(() => validateArchiveLayout(layout, archiveId)).toThrow("Ambiguous archive source identity");
  });

  test("rejects duplicate physical transcript aliases", () => {
    const layout = schema2Layout({
      entries: [
        { logical: "projects", physical: "claude/PC", store: "hub" },
        { logical: "projectAsus", physical: "claude/PC", store: "asus" },
      ],
      files: [
        { logical: "projects/a.jsonl", physical: "claude/PC/a.jsonl" },
        { logical: "projectAsus/a.jsonl", physical: "claude/PC/a.jsonl" },
      ],
    });
    expect(() => validateArchiveLayout(layout, archiveId)).toThrow("Ambiguous archive source identity");
  });

  test("rejects traversal in schema 2 source paths", () => {
    for (const file of [
      { logical: "projects/../escape.jsonl", physical: "claude/PC/escape.jsonl" },
      { logical: "projects/escape.jsonl", physical: "claude/PC/../escape.jsonl" },
    ]) {
      expect(() => validateArchiveLayout(schema2Layout({ files: [file] }), archiveId))
        .toThrow("Invalid archive source path");
    }
  });

  test("refuses schema 2 reads while a layout migration is pending", () => {
    const { root } = schema2Fixture({ phase: "moving" });
    expect(() => readArchiveLayout(root)).toThrow("Archive source layout migration is unfinished");
    expect(() => archiveLayoutPhysicalPath(root, path.join(root, "projects", "a.jsonl")))
      .toThrow("Archive source layout migration is unfinished");
  });
});
