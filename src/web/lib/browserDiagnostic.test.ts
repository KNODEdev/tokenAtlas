import { describe, expect, it } from "bun:test";
import { browserSafeDiagnostic } from "./browserDiagnostic";

describe("browserSafeDiagnostic", () => {
  it("redacts Windows, UNC and POSIX paths with spaces and removes stack frames", () => {
    const safe = browserSafeDiagnostic([
      "Error: publication failed",
      "database C:\\Users\\Alice Smith\\Private Data\\atlas.db",
      "share \\\\internal-server\\Private Share\\snapshot.json",
      "manifest /home/alice/private data/snapshot.json",
      "    at publish (/opt/token-atlas/src/publish.ts:12:4)",
      "safe code: snapshot-publication-failed",
    ].join("\n"));

    expect(safe).toContain("[ścieżka ukryta]");
    expect(safe).toContain("snapshot-publication-failed");
    for (const secret of ["Alice Smith", "Private Data", "internal-server", "Private Share", "/home/alice", "/opt/token-atlas", "at publish"]) {
      expect(safe).not.toContain(secret);
    }
  });
});
