import fs from "node:fs";
import { createHash, type Hash } from "node:crypto";

export function prefixHash(file: string, length: number): Hash {
  const fd = fs.openSync(file, "r"), hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let offset = 0;
    while (offset < length) {
      const bytes = fs.readSync(fd, buffer, 0, Math.min(buffer.length, length - offset), offset);
      if (!bytes) throw new Error(`Gauge journal shortened during read: ${file}`);
      hash.update(buffer.subarray(0, bytes)); offset += bytes;
    }
    return hash;
  } finally { fs.closeSync(fd); }
}

export interface JournalLine {
  line: string;
  offset: number;
  raw: Record<string, unknown> | null;
  entry_id: string | null;
  compact: boolean;
  canonical: boolean;
}
export interface JournalSuffix {
  lines: JournalLine[];
  bytes: string[];
  consumed: number;
  done: boolean;
  prefixHash: string | null;
}
/** Only LF-complete records are accepted. A bounded batch can exceed maxBytes for one long line. */
