import fs from "node:fs";
import path from "node:path";
import { publishArchiveFile } from "../../src/sync/archive-publication";
import { initializeArchiveWriterIdentity } from "../../src/sync/archive-writers";
import { ARCHIVE_ROOT, archive, home, MACHINE } from "../../src/config/paths";
const DEFAULT_SOURCE = path.join(
  process.env.APPDATA || home("AppData", "Roaming"),
  "Claude",
  "local-agent-mode-sessions"
);
const DEFAULT_DEST = archive("claude", `${MACHINE}-desktop`);
const MAX_DESTINATION_CONFLICT_ATTEMPTS = 3;
function isDestinationConflict(error: unknown, destination: string): boolean {
  return error instanceof Error &&
    error.message === `Archive destination changed during publication: ${destination}`;
}
function publishDesktopFile(source: string, destination: string, archiveRoot: string): "copied" | "unchanged" {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return publishArchiveFile(source, destination, { archiveRoot, jsonl: true });
    } catch (error) {
      if (attempt >= MAX_DESTINATION_CONFLICT_ATTEMPTS || !isDestinationConflict(error, destination)) throw error;
    }
  }
}
function findTranscripts(root: string): string[] {
  const hits: string[] = [];
  function walk(dir: string) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (
        e.isFile() &&
        e.name.endsWith(".jsonl") &&
        (p.includes(`${path.sep}.claude${path.sep}projects${path.sep}`) || e.name === "audit.jsonl")
      ) {
        hits.push(p);
      }
    }
  }
  walk(root);
  return hits;
}
function localIdOf(p: string): string {
  const m = p.match(/local_([0-9a-f-]+)/i);
  return m?.[1]?.slice(0, 8) ?? "session";
}
export function mirrorDesktop(source: string, dest: string, archiveRoot = ARCHIVE_ROOT,
  selectedFiles?: string[], published?: (file: string) => void) {
  let copied = 0;
  let unchanged = 0;
  const files=selectedFiles??findTranscripts(source);
  for (const src of files) {
    const relative=path.relative(path.resolve(source),path.resolve(src));
    if(!relative||relative===".."||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw new Error(`Desktop input outside source root: ${src}`);
    if(!src.endsWith(".jsonl")||(!src.includes(`${path.sep}.claude${path.sep}projects${path.sep}`)&&path.basename(src)!=="audit.jsonl"))continue;
    if(!fs.existsSync(src))continue;
    const out = path.join(dest, `${localIdOf(src)}-${path.basename(src)}`);
    const status = publishDesktopFile(src, out, archiveRoot);
    published?.(out);
    if (status === "copied") copied++;
    else unchanged++;
  }
  return { copied, unchanged };
}

if (import.meta.main) {
  initializeArchiveWriterIdentity();
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const source = flag("--source") ?? DEFAULT_SOURCE;
  const dest = flag("--dest") ?? DEFAULT_DEST;
  const result = mirrorDesktop(source, dest);
  console.log(`desktop mirror: ${result.copied} copied, ${result.unchanged} unchanged -> ${dest}`);
}
