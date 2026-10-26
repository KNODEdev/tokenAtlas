import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repairDependencies } from "./repair-dependencies";

for (const exit of [0, 7]) {
  test(`dependency repair preserves old files, bypasses the shared cache and propagates exit ${exit}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-dependency-repair-"));
    try {
      const modules = path.join(root, "node_modules"), devCache = path.join(root, ".dev-cache");
      fs.mkdirSync(modules); fs.mkdirSync(devCache);
      fs.writeFileSync(path.join(modules, "old-package"), "previous contents");
      fs.writeFileSync(path.join(devCache, "bun-install.stamp"), "stale stamp");
      const preserved = [".env", "package.json", "bun.lock"];
      for (const file of preserved) fs.writeFileSync(path.join(root, file), `unchanged ${file}`);
      const result = repairDependencies(root, (args, cwd) => {
        expect(cwd).toBe(fs.realpathSync(root));
        expect(fs.existsSync(modules)).toBe(false);
        expect(fs.existsSync(path.join(devCache, "bun-install.stamp"))).toBe(false);
        expect(args.slice(0, 3)).toEqual(["install", "--frozen-lockfile", "--backend=copyfile"]);
        const cache = args.find(arg => arg.startsWith("--cache-dir="))!.slice("--cache-dir=".length);
        const config = args.find(arg => arg.startsWith("--config="))!.slice("--config=".length);
        expect(fs.readdirSync(cache)).toEqual([]);
        expect(path.relative(devCache, cache)).not.toStartWith("..");
        expect(fs.readFileSync(path.join(path.dirname(cache), "node_modules.previous", "old-package"), "utf8"))
          .toBe("previous contents");
        expect(fs.readFileSync(config, "utf8")).toContain("dryRun = false");
        expect(fs.readFileSync(config, "utf8")).toContain("production = false");
        return exit;
      });
      expect(result).toBe(exit);
      for (const file of preserved) expect(fs.readFileSync(path.join(root, file), "utf8")).toBe(`unchanged ${file}`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test("repair does not traverse a node_modules junction into another installation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-dependency-junction-"));
  try {
    const app = path.join(root, "app"), external = path.join(root, "other-installation");
    fs.mkdirSync(app); fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, "keep"), "untouched shared files");
    fs.symlinkSync(external, path.join(app, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    expect(repairDependencies(app, () => 0)).toBe(0);
    expect(fs.readFileSync(path.join(external, "keep"), "utf8")).toBe("untouched shared files");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
