import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { assignSourceMachines, knownMachines, sourceMachine } from "./source-machines";

const MACHINES = ["EXAMPLE-MAIN", "EXAMPLE-LAPTOP-A"];

describe("source machines", () => {
  test("an archive folder belongs to the computer whose name it equals or starts with before a hyphen", () => {
    expect(sourceMachine("H:\\OneDrive\\tokenUsage\\codex\\EXAMPLE-LAPTOP-A-sample_a-codex-mr", MACHINES)).toBe("EXAMPLE-LAPTOP-A");
    expect(sourceMachine("H:/OneDrive/tokenUsage/codex/EXAMPLE-MAIN-sample_a", MACHINES)).toBe("EXAMPLE-MAIN");
    expect(sourceMachine("claude/example-main", MACHINES)).toBe("EXAMPLE-MAIN");
    expect(sourceMachine("claude/example-main-desktop", MACHINES)).toBe("EXAMPLE-MAIN");
    // A longer name is not a computer's folder by a shared prefix alone, and historical copies stay unassigned.
    expect(sourceMachine("codex/EXAMPLE-MAINX-sample_a", MACHINES)).toBeNull();
    expect(sourceMachine("H:/archive/projectAsus", MACHINES)).toBeNull();
  });
  test("the longest matching computer name wins", () => {
    expect(sourceMachine("codex/PC-2-sample_a", ["PC", "PC-2"])).toBe("PC-2");
  });
  test("computers come from the probe source register; an index without it assigns none", () => {
    const db = new Database(":memory:");
    expect(knownMachines(db)).toEqual([]);
    db.run("CREATE TABLE probe_source_tuples (provider TEXT, machine TEXT, home TEXT, login TEXT)");
    db.run("INSERT INTO probe_source_tuples VALUES ('codex', 'EXAMPLE-MAIN', 'h', 'sample_a'), ('claude', 'EXAMPLE-MAIN', 'h2', 'sample_a'), ('codex', 'EXAMPLE-LAPTOP-A', 'h', 'sample_a')");
    expect(knownMachines(db).sort()).toEqual(["EXAMPLE-LAPTOP-A", "EXAMPLE-MAIN"]);
    const source = (name: string) => ({ name, machine: null as string | null, first: "", last: "" });
    const detailed = { timeline: { readings: [], usage: [], sources: [source("codex/EXAMPLE-LAPTOP-A-sample_a"), source("codex/OTHER-sample_a")] } };
    assignSourceMachines(db, [detailed, {}] as Parameters<typeof assignSourceMachines>[1]);
    expect(detailed.timeline.sources.map(s => s.machine)).toEqual(["EXAMPLE-LAPTOP-A", null]);
  });
});
