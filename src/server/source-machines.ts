import type { Database } from "bun:sqlite";
import type { CapacityCycleTimeline } from "../shared/capacity-cycle";

/** Computers that recorded probe readings: the names their archive folders start with. */
export function knownMachines(sqlite: Database): string[] {
  try {
    return (sqlite.query("SELECT DISTINCT machine FROM probe_source_tuples WHERE machine IS NOT NULL AND machine <> ''").all() as Array<{ machine: string }>)
      .map(row => row.machine);
  } catch {
    // An index older than the probe source register knows no computers; sources stay unassigned.
    return [];
  }
}

/**
 * The computer of an archive source (`…/codex/EXAMPLE-LAPTOP-A-sample_a`, `claude/example-main`): each machine
 * writes `<MACHINE>` or `<MACHINE>-<login…>` folders, so the longest known name that the folder equals or
 * starts with before a hyphen. Null when none matches (historical copies, unknown computers).
 */
export function sourceMachine(name: string, machines: readonly string[]): string | null {
  const folder = name.split(/[\\/]/).filter(Boolean).at(-1)?.toLowerCase() ?? "";
  let found: string | null = null;
  for (const machine of machines) {
    const key = machine.toLowerCase();
    if ((folder === key || folder.startsWith(key + "-")) && (found === null || machine.length > found.length)) found = machine;
  }
  return found;
}

/** Names the computer of every source on the time axis of the detailed windows; other windows are untouched. */
export function assignSourceMachines<W extends { timeline?: CapacityCycleTimeline }>(sqlite: Database, windows: W[]): W[] {
  const detailed = windows.filter(w => w.timeline?.sources?.length);
  if (!detailed.length) return windows;
  const machines = knownMachines(sqlite);
  for (const w of detailed) for (const source of w.timeline!.sources!) source.machine = sourceMachine(source.name, machines);
  return windows;
}
