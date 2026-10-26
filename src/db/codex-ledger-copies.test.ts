import { expect, test } from "bun:test";
import path from "node:path";
import { Database } from "./sqlite";
import { bindCanonicalArchiveRoot } from "../config/archive-paths";
import { createCodexLedgerSchema } from "./codex-price-ledger";
import { ledgerCopyAnchorFromArchive, registerCodexCopy } from "./codex-ledger-copies";

test("a relocated archive root keeps every copy's anchor; same-content files stay distinct copies", () => {
  const original = bindCanonicalArchiveRoot(null, "shared-archive", path.resolve("TMP", "archive-a"));
  const moved = bindCanonicalArchiveRoot(original, "shared-archive", path.resolve("TMP", "archive-b"));
  const anchorIn = (root: typeof original, name: string) => ledgerCopyAnchorFromArchive(root, "declared-source", path.join(root.currentPhysicalRoot, "codex", "PC", name));
  expect(anchorIn(original, "a.jsonl")).toEqual(anchorIn(moved, "a.jsonl"));
  expect(anchorIn(original, "a.jsonl").relativePath).toBe("codex/PC/a.jsonl");
  const db = new Database(":memory:");
  try {
    createCodexLedgerSchema(db);
    const a = registerCodexCopy(db, "home", path.join(original.currentPhysicalRoot, "codex", "PC", "a.jsonl"), anchorIn(original, "a.jsonl"));
    const b = registerCodexCopy(db, "home", path.join(original.currentPhysicalRoot, "codex", "PC", "b.jsonl"), anchorIn(original, "b.jsonl"));
    expect(b).not.toBe(a);
    expect(registerCodexCopy(db, "home", path.join(original.currentPhysicalRoot, "codex", "PC", "a.jsonl.zst"),
      anchorIn(original, "a.jsonl.zst"))).toBe(a);
    expect(db.query("SELECT COUNT(*) AS n FROM codex_price_ledger_copies").get()).toEqual({ n: 2 });
    const relocated = path.join(moved.currentPhysicalRoot, "codex", "PC", "a.jsonl");
    expect(registerCodexCopy(db, "home", relocated, anchorIn(moved, "a.jsonl"))).toBe(a);
    expect(db.query("SELECT path,conversation FROM codex_price_ledger_copies WHERE id=?").get(a))
      .toEqual({ path: relocated, conversation: "declared-source|a.jsonl" });
  } finally { db.close(); }
});

test("real declared source namespaces are accepted without allowing traversal or malformed source identities", () => {
  const root = bindCanonicalArchiveRoot(null, "shared-archive", path.resolve("TMP", "declared-source-anchor"));
  const file = path.join(root.currentPhysicalRoot, "codex", "PC", "a.jsonl");
  expect(ledgerCopyAnchorFromArchive(root, "codex/example-main-sample_a", file).sourceId).toBe("codex/example-main-sample_a");
  for (const source of ["", "../codex", "codex/../main", "codex//main", "/codex/main", "codex/main\n", "codex\\main", "x".repeat(513)]) {
    expect(() => ledgerCopyAnchorFromArchive(root, source, file)).toThrow("declared source identity");
  }
});
