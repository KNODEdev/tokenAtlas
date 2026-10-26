import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { violations } from "../../scripts/dev/paper-atlas-audit";

// docs/design/paper-atlas.md: every screen speaks one visual language. `bun scripts/dev/paper-atlas-audit.ts`
// lists the offending files.
describe("paper atlas", () => {
  test("the audit checks authored sources while excluding temporary generated bundles", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paper-atlas-audit-"));
    try {
      fs.mkdirSync(path.join(root, "TMP"));
      fs.writeFileSync(path.join(root, "TMP", "bundle.css"), "body{border-radius:10px;color:#123456;text-transform:uppercase}");
      fs.writeFileSync(path.join(root, "authored.css"), "body{border-radius:10px}");
      expect(violations(root)).toEqual(["authored.css:1 numeric corner instead of a shape token"]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test("components use tokens for colour, font and shape and no capitals", () => {
    expect(violations()).toEqual([]);
  });
});
