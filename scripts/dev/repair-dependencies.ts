import fs from "node:fs";
import path from "node:path";

type Install = (args: string[], cwd: string) => number;

/** A forced reinstall can reuse broken package files; repair needs a new tree and empty cache. */
export function repairDependencies(repo: string, install: Install = (args, cwd) =>
  Bun.spawnSync([process.execPath, ...args], { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exitCode): number {
  const root = fs.realpathSync(repo);
  const devCache = path.join(root, ".dev-cache");
  fs.mkdirSync(devCache, { recursive: true });
  const repair = fs.mkdtempSync(path.join(devCache, "dependency-repair-"));
  const modules = path.join(root, "node_modules");
  const backup = path.join(repair, "node_modules.previous");
  // Rename the entry itself, including junctions; never traverse or delete a shared package tree.
  try { fs.lstatSync(modules); fs.renameSync(modules, backup); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  fs.rmSync(path.join(devCache, "bun-install.stamp"), { force: true });
  const cache = path.join(repair, "cache"), config = path.join(repair, "bunfig.toml");
  fs.mkdirSync(cache);
  // An inherited dry-run or production-only configuration must not suppress a DEV installation.
  fs.writeFileSync(config, "[install]\ndryRun = false\nproduction = false\ndev = true\noptional = true\npeer = true\n");
  console.log(`[1] Repair files and previous dependencies: ${repair}`);
  return install(["install", "--frozen-lockfile", "--backend=copyfile", `--cache-dir=${cache}`, `--config=${config}`], root);
}

if (import.meta.main) {
  try { process.exitCode = repairDependencies(path.resolve(import.meta.dir, "../..")); }
  catch (error) {
    console.error("Dependency repair failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
