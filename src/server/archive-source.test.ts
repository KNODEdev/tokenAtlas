import { expect, test } from "bun:test";
import { archiveSourceOf, type SourceDeclaration } from "./archive-source";

const ROOT = "H:\\OneDrive\\Archive";
const declarations: SourceDeclaration[] = [
  { vendor: "codex", machine: "PC", home: "H:/OneDrive/Archive/codex/PC-agy11", source_home: "C:/Users/sample_a/.codex-mr" },
  { vendor: "codex", machine: "LAPTOP", home: "H:/OneDrive/Archive/codex/LAPTOP-sample_a-codex-mr", source_home: "C:/Users/sample_a/.codex-mr" },
  { vendor: "anthropic", machine: "PC", home: "H:/OneDrive/Archive/claude/PC-sample_a-claude-2/", source_home: "C:\\Users\\sample_a\\.claude-2" },
  // Two accounts of one profile over time are still one folder.
  { vendor: "codex", machine: "PC", home: "H:/OneDrive/Archive/codex/PC-sample_b", source_home: "C:/Users/sample_b/.codex" },
  { vendor: "codex", machine: "PC", home: "H:/OneDrive/Archive/codex/PC-sample_b", source_home: "C:/Users/sample_b/.codex" },
  { vendor: "claude", machine: "PC", home: "H:/OneDrive/Archive/claude/PC" },
];
const source = (vendor: string, machine: string, login: string, home: string) =>
  archiveSourceOf(vendor, { machine, login, home }, declarations, ROOT, "sample_a");

test("a declared profile resolves to its declared folder, per computer", () => {
  expect(source("codex", "PC", "sample_a", "C:\\Users\\sample_a\\.codex-mr")).toBe("codex/pc-agy11");
  expect(source("codex", "LAPTOP", "sample_a", "C:\\Users\\sample_a\\.codex-mr")).toBe("codex/laptop-sample_a-codex-mr");
  expect(source("claude", "PC", "sample_a", "C:/Users/sample_a/.claude-2")).toBe("claude/pc-sample_a-claude-2");
  expect(source("codex", "PC", "sample_b", "C:/Users/sample_b/.codex")).toBe("codex/pc-sample_b");
});

test("an undeclared conventional profile resolves to the conventional folder", () => {
  expect(source("codex", "PC", "sample_a", "C:\\Users\\sample_a\\.codex")).toBe("codex/pc-sample_a");
  expect(source("grok", "LAPTOP", "sample_a", "C:/Users/sample_a/.grok")).toBe("grok/laptop-sample_a");
  expect(source("claude", "PC", "sample_a", "C:/Users/sample_a/.claude")).toBe("claude/pc");
});

test("a profile without an archive folder resolves to nothing", () => {
  expect(source("claude", "PC", "sample_c", "C:/Users/sample_c/.claude")).toBeNull();
  expect(source("codex", "PC", "sample_a", "C:/Users/sample_a/.codex-9")).toBeNull();
  expect(archiveSourceOf("codex", { machine: "PC", login: "x", home: "C:/Users/x/.codex-mr" }, [
    { vendor: "codex", home: "H:/OneDrive/Archive/codex/a", source_home: "C:/Users/x/.codex-mr" },
    { vendor: "codex", home: "H:/OneDrive/Archive/codex/b", source_home: "C:/Users/x/.codex-mr" },
  ], ROOT, "sample_a")).toBeNull();
});

test("an Antigravity pool worker resolves to the folder of the Windows account it runs under", () => {
  // `pool:<id>` names the worker, not the account: `pool:main` runs as `sample_a`.
  expect(source("gemini", "PC", "agy08", "pool:agy08")).toBe("gemini/pc-agy08");
  expect(source("gemini", "PC", "sample_a", "pool:main")).toBe("gemini/pc-sample_a");
  const moved: SourceDeclaration[] = [{ vendor: "gemini", machine: "PC", home: "H:/OneDrive/Archive/gemini/PC-pool-08", source_home: "C:/Users/agy08/.gemini" }];
  expect(archiveSourceOf("gemini", { machine: "PC", login: "agy08", home: "pool:agy08" }, moved, ROOT, "sample_a")).toBe("gemini/pc-pool-08");
  expect(source("codex", "PC", "agy08", "pool:agy08")).toBeNull();
});
