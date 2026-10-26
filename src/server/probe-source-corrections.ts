import fs from "node:fs";
import path from "node:path";
import { CONFIG_ROOT } from "../config/paths";
import { normEraVendor } from "./eras";

export const PROBE_SOURCE_CORRECTIONS_FILE = "probe-source-corrections.json";

export interface ProbeSourceCorrection {
  provider: string;
  subject: string;
  from: string;
  until: string;
  source: string;
  evidence: string;
}

/** Owner-declared source for a bounded cohort whose verified canonical fact has no physical source. */
export function readProbeSourceCorrections(root = CONFIG_ROOT): ProbeSourceCorrection[] {
  const file = path.join(root, PROBE_SOURCE_CORRECTIONS_FILE);
  if (!fs.existsSync(file)) return [];
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
    (parsed as { version?: unknown }).version !== 1 || !Array.isArray((parsed as { corrections?: unknown }).corrections))
    throw new Error(`${file}: expected version 1 and a corrections array`);
  const corrections = (parsed as { corrections: unknown[] }).corrections.map((value, index) => {
    const row = value as Partial<ProbeSourceCorrection>;
    const fields = [row?.provider, row?.subject, row?.from, row?.until, row?.source, row?.evidence];
    if (fields.some(field => typeof field !== "string" || !field.trim()))
      throw new Error(`${file}: corrections[${index}] needs provider, subject, from, until, source and evidence`);
    const correction = row as ProbeSourceCorrection;
    const from = Date.parse(correction.from), until = Date.parse(correction.until);
    if (!Number.isFinite(from) || !Number.isFinite(until) || from >= until ||
      !correction.source.toLowerCase().startsWith(`${normEraVendor(correction.provider)}/`))
      throw new Error(`${file}: corrections[${index}] has invalid bounds or source`);
    return { ...correction, from: new Date(from).toISOString(), until: new Date(until).toISOString(),
      source: correction.source.toLowerCase() };
  });
  for (let i = 0; i < corrections.length; i++) for (let j = i + 1; j < corrections.length; j++) {
    const a = corrections[i]!, b = corrections[j]!;
    if (normEraVendor(a.provider) === normEraVendor(b.provider) && a.subject === b.subject &&
      a.from < b.until && b.from < a.until)
      throw new Error(`${file}: overlapping corrections[${i}] and corrections[${j}]`);
  }
  return corrections;
}

export function declaredProbeSource(row: { provider: string; subject?: string; ts?: string; machine?: string | null },
  corrections: readonly ProbeSourceCorrection[]): string | null {
  if (row.machine !== null) return null;
  const at = Date.parse(row.ts ?? "");
  if (!Number.isFinite(at)) return null;
  return corrections.find(correction => normEraVendor(correction.provider) === normEraVendor(row.provider)
    && correction.subject === row.subject && at >= Date.parse(correction.from)
    && at < Date.parse(correction.until))?.source.toLowerCase() ?? null;
}
