import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sourceDependencyFiles } from "./source-dependencies";

test("runtime provenance follows re-exports, dynamic imports and cycles without loading source code", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-source-dependencies-"));
  try {
    fs.mkdirSync(path.join(root, "nested"));
    fs.writeFileSync(path.join(root, "entry.ts"), `
      import type { Missing } from "./types-only";
      export { value } from "./nested";
      const later = () => import("./later.ts");
      throw new Error("Source provenance must not execute this file");
    `);
    fs.writeFileSync(path.join(root, "nested/index.ts"), 'export { value } from "../entry"; import "node:fs";');
    fs.writeFileSync(path.join(root, "later.ts"), 'import "./data.json";');
    fs.writeFileSync(path.join(root, "data.json"), '{"value":1}');
    expect(sourceDependencyFiles(root, ["entry.ts", "entry.ts"])).toEqual([
      "data.json", "entry.ts", "later.ts", "nested/index.ts",
    ]);
    fs.writeFileSync(path.join(root, "later.ts"), 'import "./missing";');
    expect(() => sourceDependencyFiles(root, ["entry.ts"])).toThrow("Cannot resolve runtime source");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
