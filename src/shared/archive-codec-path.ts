export type ArchiveCodecVendor = "codex" | "claude" | "grok";
export type ArchiveCodecFormat = "jsonl";

/** Only provider history handled by an importer; audit, settings and gauge journals stay plain. */
export function archiveCodecSource(relative: string): { vendor: ArchiveCodecVendor; format: ArchiveCodecFormat } | null {
  const file = archiveSourceIdentity(relative).replaceAll("\\", "/");
  if (/\.conflict-[a-f0-9]{64}(?:\.|$)/i.test(file)) return null;
  if (file.split("/").some(part => !part || part === "." || part === ".." || part.startsWith("."))) return null;
  if (/^codex\/[^/]+\/(?:sessions|archived_sessions)\/.+\.jsonl$/i.test(file)) return { vendor: "codex", format: "jsonl" };
  if (/^claude\/[^/]+\/.+\.jsonl$/i.test(file) && !/(?:^|\/)(?:[^/]*-)?audit\.jsonl$/i.test(file)) return { vendor: "claude", format: "jsonl" };
  if (/^grok\/[^/]+\/sessions\/[^/]+\/[^/]+\/updates\.jsonl$/i.test(file)) return { vendor: "grok", format: "jsonl" };
  return null;
}

/** Storage codec is not part of the durable source identity. */
export const archiveSourceIdentity = (file: string): string => file.replace(/(\.jsonl)\.zst$/i, "$1");
export const compressedArchiveSource = (file: string): boolean => /\.jsonl\.zst$/i.test(file);
export const jsonlArchiveSource = (file: string): boolean => /\.jsonl(?:\.zst)?$/i.test(file);
