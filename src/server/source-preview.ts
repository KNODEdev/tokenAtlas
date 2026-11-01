import fs from "node:fs";
import { ARCHIVE_ROOT } from "../config/paths";
import { syncFileRoots } from "../sync/mirror";
import { readGlmKey } from "../providers/adapters/glm";
import { CLOUD_API_ORIGIN } from "../sync/claude-cloud-api";
import { measureSourceFiles } from "./first-import";

/** One detected source as the consent screen lists it: what would be copied into the archive. */
export interface SourcePreviewItem { vendor: string; paths: string[]; files: number; bytes: number }
/** Hosts a limit reading of one provider contacts; Codex is read through the user's own Codex CLI. */
export interface ReadingDestination { vendor: string; hosts: string[]; via_cli?: boolean }
export interface SourcePreview {
  archive: string;
  sources: SourcePreviewItem[];
  readings: ReadingDestination[];
  cloud: { hosts: string[] };
  rates: { hosts: string[] };
}

const READING_HOSTS: Record<string, ReadingDestination> = {
  claude: { vendor: "claude", hosts: ["api.anthropic.com", "platform.claude.com"] },
  // The CLI chooses its own OpenAI endpoint; the app itself sends nothing for Codex.
  codex: { vendor: "codex", hosts: [], via_cli: true },
};

let cached: Promise<SourcePreview> | null = null;

/**
 * What the first import would copy and whom the app would contact (TALK-001 D11), measured from directory
 * entries only. Cached per process: the scan of a large profile takes seconds and the screen may ask twice.
 */
export function readSourcePreview(refresh = false): Promise<SourcePreview> {
  if (!cached || refresh) cached = measure().catch(error => { cached = null; throw error; });
  return cached;
}

async function measure(): Promise<SourcePreview> {
  const byVendor = new Map<string, string[]>();
  for (const root of syncFileRoots()) {
    if (root.kind !== "source" || !fs.existsSync(root.path)) continue;
    byVendor.set(root.vendor, [...(byVendor.get(root.vendor) ?? []), root.path]);
  }
  const sources = await Promise.all([...byVendor].map(async ([vendor, paths]) => ({ vendor, paths, ...await measureSourceFiles(paths.map(path => ({ path }))) })));
  const readings = sources.flatMap(source => READING_HOSTS[source.vendor] ? [READING_HOSTS[source.vendor]!] : []);
  let glm = false;
  try { glm = !!readGlmKey().creds; } catch { glm = false; }
  if (glm) readings.push({ vendor: "glm", hosts: ["api.z.ai"] });
  return {
    archive: ARCHIVE_ROOT,
    sources,
    readings,
    cloud: { hosts: [new URL(CLOUD_API_ORIGIN).host] },
    rates: { hosts: ["api.nbp.pl"] },
  };
}
