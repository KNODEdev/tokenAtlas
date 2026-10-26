import fs from "node:fs";
import path from "node:path";

// docs/design/paper-atlas.md: every screen speaks one visual language. Components take colours,
// fonts and corner shapes from tokens, and never style text as capitals.
const WEB = path.join(import.meta.dir, "..", "..", "src", "web");
// Token sources may define literal values; everything else must reference them.
const TOKEN_FILES = new Set(["tokens.css", path.join("components", "ui.css")]);

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // Generated trial bundles contain expanded tokens and are not authored UI sources.
    if (entry.isDirectory()) { if (entry.name !== "fonts" && entry.name.toUpperCase() !== "TMP") sources(full, out); continue; }
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    if (/\.(tsx|css)$/.test(entry.name) || /\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

const RULES: Array<{ name: string; pattern: RegExp; css?: boolean; ts?: boolean }> = [
  { name: "capitals as style", pattern: /text-?transform:\s*["']?uppercase/gi, css: true, ts: true },
  { name: "font name instead of a font token", pattern: /(font-family:\s*["'](?!inherit)|fontFamily:\s*["'`](?!var\(|inherit))/g, css: true, ts: true },
  { name: "numeric corner instead of a shape token", pattern: /(border-radius:\s*\d+(\.\d+)?px|borderRadius:\s*["']?\d+(\.\d+)?(px)?["']?\s*[,}])/g, css: true, ts: true },
  { name: "side accent stripe instead of a selection wash", pattern: /inset\s+-?[1-9]\d*px\s+0(px)?\s+0/g, css: true, ts: true },
  { name: "colour literal instead of a colour token", pattern: /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-fA-F])|rgba?\(\s*\d/g, css: true, ts: true },
];

export function violations(root = WEB): string[] {
  const found: string[] = [];
  for (const file of sources(root)) {
    const rel = path.relative(root, file);
    if (TOKEN_FILES.has(rel)) continue;
    const isCss = file.endsWith(".css");
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
      for (const rule of RULES) {
        if (isCss ? !rule.css : !rule.ts) continue;
        // A zero radius and a circle are geometry, not style.
        const hits = [...line.matchAll(rule.pattern)].filter((m) => !(rule.name.startsWith("numeric corner") && /:\s*["']?0(px)?["']?\s*[,}]/.test(m[0])));
        if (hits.length) found.push(`${rel}:${i + 1} ${rule.name}`);
      }
    });
  }
  return found;
}

if (import.meta.main) {
  const list = violations();
  const byFile = new Map<string, number>();
  for (const v of list) { const f = v.split(":")[0]!; byFile.set(f, (byFile.get(f) ?? 0) + 1); }
  console.log([...byFile].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${n}\t${f}`).join("\n"));
  console.log("total", list.length);
}
