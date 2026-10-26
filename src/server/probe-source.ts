import { archiveSourceOf, type SourceDeclaration } from "./archive-source";
import { subscriptionRowSource } from "./event-source";
import type { ProbeSourceCorrection } from "./probe-source-corrections";

export interface ProbeSourceOptions {
  declarations: readonly SourceDeclaration[];
  archiveRoot: string;
  defaultLogin: string;
  corrections?: readonly ProbeSourceCorrection[];
}

/** Physical evidence shared by database rows and original journal/canonical payloads. */
export interface ProbeSourceRow {
  provider: string;
  machine?: string | null;
  profile?: string | null;
  extra?: unknown;
  login?: string | null;
  source_home?: string | null;
}
export interface ProbePhysicalProfile { machine: string; home: string; login: string }

function object(value: unknown): Record<string, unknown> | null {
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;

function windowsLogin(home: string): string | null {
  const path = home.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\/users\/([^/]+)\/[^/]+$/i.exec(path)?.[1] ?? null;
}

/**
 * The Windows account an Antigravity pool worker (`pool:<id>`, `vendor-identity.ts`) runs under: the
 * profile its discovery entry names, else the reading's profile. The id is not the login (`pool:main`
 * runs as `sample_a`), and the probing process's login is not the worker's.
 */
function poolWorkerLogin(home: string, row: ProbeSourceRow, extra: Record<string, unknown> | null): string | null {
  if (!/^pool:[^/\\]+$/i.test(home)) return null;
  const vendor = object(extra?.vendor_account);
  const entry = Array.isArray(vendor?.profiles) ? vendor.profiles.map(object).find(p => text(p?.home) === home) : null;
  return text(entry?.login) ?? text(row.profile);
}

/** Captured profile coordinates, independent of account declarations. */
export function probePhysicalProfileOf(row: ProbeSourceRow): ProbePhysicalProfile | null {
  const extra = object(row.extra);
  const codex = object(extra?.codex_account);
  const machine = text(row.machine) ?? text(codex?.machine);
  const home = text(row.source_home) ?? text(codex?.home) ?? text(extra?.home);
  // The process login can differ from the owner of an archived user's profile.
  const login = (home ? windowsLogin(home) ?? poolWorkerLogin(home, row, extra) : null)
    ?? text(row.login) ?? text(codex?.login) ?? text(row.profile);
  return machine && home && login ? { machine, home, login } : null;
}

/**
 * The physical coordinates that decide a reading's archive source: the computer alone for GLM/OpenCode,
 * the captured profile (computer, home, login) for every other provider; null without them.
 * Independent of declarations, so it is stored once per reading (`probe_sources`).
 */
export type ProbeSourceTuple = ProbePhysicalProfile;
const machineOnly = (provider: string) => provider === "glm" || provider === "opencode";
export function probeSourceTupleOf(row: ProbeSourceRow): ProbeSourceTuple | null {
  if (machineOnly(row.provider)) {
    const machine = text(row.machine);
    return machine ? { machine, home: "", login: "" } : null;
  }
  return probePhysicalProfileOf(row);
}
/** The archive source of physical coordinates under the given declarations. */
export function sourceOfProbeTuple(provider: string, tuple: ProbeSourceTuple, options: ProbeSourceOptions): string | null {
  // GLM/OpenCode events and probes identify their physical source by computer alone.
  if (machineOnly(provider)) return subscriptionRowSource("glm", { store: tuple.machine }, options.archiveRoot);
  return archiveSourceOf(provider, tuple, options.declarations, options.archiveRoot, options.defaultLogin);
}

/** Resolve the archive source from physical evidence, regardless of its stored account stamp. */
export function probeArchiveSourceOf(row: ProbeSourceRow, options: ProbeSourceOptions): string | null {
  const tuple = probeSourceTupleOf(row);
  return tuple ? sourceOfProbeTuple(row.provider, tuple, options) : null;
}
