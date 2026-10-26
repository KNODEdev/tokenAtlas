import fs from "node:fs";
import path from "node:path";

/** Local runtime imports follow a split entry; computed paths and Worker URLs need explicit seeds. */
export function sourceDependencyFiles(root: string, entries: readonly string[]): string[] {
  const pending = entries.map(file => path.resolve(root, file));
  const found = new Set<string>();
  const transpilers = {
    ts: new Bun.Transpiler({ loader: "ts" }),
    tsx: new Bun.Transpiler({ loader: "tsx" }),
    js: new Bun.Transpiler({ loader: "js" }),
  };
  while (pending.length) {
    const file = pending.pop()!;
    if (found.has(file)) continue;
    const relative = path.relative(root, file);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error(`Runtime source is outside the repository: ${file}`);
    found.add(file);
    const extension = path.extname(file);
    if (extension === ".json") continue;
    const transpiler = extension === ".tsx" ? transpilers.tsx : extension === ".ts" ? transpilers.ts : transpilers.js;
    const imports = transpiler.scanImports(fs.readFileSync(file, "utf8"));
    for (const dependency of imports) {
      if (!dependency.path.startsWith(".")) continue;
      const base = path.resolve(path.dirname(file), dependency.path);
      const resolved = [base, ...[".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"].map(ext => base + ext),
        ...["index.ts", "index.tsx", "index.js"].map(name => path.join(base, name))]
        .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (!resolved) throw new Error(`Cannot resolve runtime source ${dependency.path} from ${file}`);
      pending.push(resolved);
    }
  }
  return [...found].map(file => path.relative(root, file).split(path.sep).join("/")).sort();
}
