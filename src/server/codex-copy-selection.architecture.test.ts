import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

// U3.2: duplicate Codex copies are resolved once, per call, when the ledger is built
// (src/db/codex-ledger-canonical.ts). No reader may choose physical copies again.
const FORBIDDEN = ["selectCodexLedgerCopies", "codexLedgerCopySelection", "codexRangeCopySelection", "codexLedgerMirrorWinners",
  "buildCodexMirrorWinners", "keepUnmirroredCodexRows", "codexMirrorSelection", "codexCopiesForRange", "wholeHistoryCopySelection",
  "CODEX_MIRROR_POLICY_VERSION", "CodexMirrorWinners", "selectCopies"];

function sources(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

test("no copy-selection function remains in src/", () => {
  const root = path.resolve(import.meta.dir, "..");
  const self = path.resolve(import.meta.path);
  const offenders = sources(root).filter(file => path.resolve(file) !== self).flatMap(file => {
    const text = fs.readFileSync(file, "utf8");
    return FORBIDDEN.filter(name => new RegExp(`\b${name}\b`).test(text)).map(name => `${path.relative(root, file)}: ${name}`);
  });
  expect(offenders).toEqual([]);
});
