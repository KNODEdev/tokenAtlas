import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repairDependencies } from "./repair-dependencies";

for (const exit of [0, 7]) {
  test(`dependency repair cleans its cache and retains recovery files only on failure (exit ${exit})`, () => {
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
        fs.writeFileSync(path.join(cache, "download"), "disposable cache");
        if (exit === 0) fs.mkdirSync(modules);
        return exit;
      });
      expect(result).toBe(exit);
      const repairs = fs.readdirSync(devCache).filter(name => name.startsWith("dependency-repair-"));
      expect(repairs).toHaveLength(exit === 0 ? 0 : 1);
      if (exit !== 0) {
        expect(fs.readdirSync(path.join(devCache, repairs[0]!))).toEqual(["node_modules.previous"]);
        expect(fs.readFileSync(path.join(devCache, repairs[0]!, "node_modules.previous", "old-package"), "utf8"))
          .toBe("previous contents");
      }
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
    expect(repairDependencies(app, () => { fs.mkdirSync(path.join(app, "node_modules")); return 0; })).toBe(0);
    expect(fs.readFileSync(path.join(external, "keep"), "utf8")).toBe("untouched shared files");
    expect(fs.readdirSync(path.join(app, ".dev-cache"))).toEqual([]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an installer exception clears downloads and preserves previous dependencies", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-dependency-exception-"));
  try {
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "node_modules", "keep"), "recovery");
    expect(() => repairDependencies(root, () => { throw new Error("install interrupted"); })).toThrow("install interrupted");
    const devCache = path.join(root, ".dev-cache"), repairs = fs.readdirSync(devCache);
    expect(repairs).toHaveLength(1);
    expect(fs.readdirSync(path.join(devCache, repairs[0]!))).toEqual(["node_modules.previous"]);
    expect(fs.readFileSync(path.join(devCache, repairs[0]!, "node_modules.previous", "keep"), "utf8")).toBe("recovery");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
