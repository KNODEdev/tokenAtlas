import { expect, test } from "bun:test";
import { createProbeCollection } from "../db/probe-facts";
import { buildAccountResolver } from "./account-resolver";
import type { DatedPeriod } from "./account-periods";
import { probeArchiveSourceOf, probePhysicalProfileOf, type ProbeSourceOptions } from "./probe-source";

const options: ProbeSourceOptions = {
  archiveRoot: "H:/Archive", defaultLogin: "sample_a",
  declarations: [
    { vendor: "codex", machine: "PC", home: "H:/Archive/codex/PC-agy11", source_home: "C:/Users/sample_a/.codex-mr" },
    { vendor: "codex", machine: "LAPTOP", home: "H:/Archive/codex/LAPTOP-agy11", source_home: "C:/Users/sample_a/.codex-mr" },
  ],
};

test("stale subjects and era flags cannot change the physical source; machines stay separate", () => {
  const row = { provider: "codex", subject: "old-account", era_unattributed: 1,
    machine: "PC", profile: null, extra: JSON.stringify({ codex_account: JSON.stringify({
      subscription: "new-account", machine: "PC", login: "sample_a", home: "C:/Users/sample_a/.codex-mr",
    }) }) };
  expect(probeArchiveSourceOf(row, options)).toBe("codex/pc-agy11");
  const laptop = { ...row, subject: "era_unattributed", machine: "LAPTOP" };
  expect(probeArchiveSourceOf(laptop, options)).toBe("codex/laptop-agy11");
});

test("canonical source home owner wins over process login; non-user homes use login fallback", () => {
  const canonical = { provider: "codex", machine: "PC", login: "canonical",
    source_home: "C:/Users/sample_a/.codex", subject: "account-label",
    extra: { home: "C:/Users/other/.codex", codex_account: { login: "other", home: "C:/Users/other/.codex" } },
  };
  expect(probeArchiveSourceOf(canonical, options)).toBe("codex/pc-sample_a");
  expect(probeArchiveSourceOf({ ...canonical, source_home: "D:/Profiles/shared/.codex" }, options))
    .toBe("codex/pc-canonical");
  expect(probeArchiveSourceOf({ provider: "codex", machine: "PC", login: "sample_a",
    source_home: "C:/Users/sample_a/.codex-mr", extra: { note: "no observed account" },
  }, options)).toBe("codex/pc-agy11");
});

test("missing or ambiguous physical evidence stays unknown", () => {
  const row = { provider: "codex", subject: "codex1", machine: "PC", profile: null };
  expect(probeArchiveSourceOf(row, options)).toBeNull();
  expect(probeArchiveSourceOf({ ...row, extra: { home: "C:/Profiles/unknown/.codex" } }, options)).toBeNull();
  expect(probeArchiveSourceOf({ ...row, extra: { home: "C:/Users/sample_a/.codex-9" } }, options)).toBeNull();
  expect(probeArchiveSourceOf({ ...row, extra: { home: "C:/Users/sample_a/.codex" }, machine: null }, options)).toBeNull();
  const ambiguous: ProbeSourceOptions = { ...options, declarations: [
    { vendor: "codex", machine: "PC", home: "H:/Archive/codex/a", source_home: "C:/Users/sample_a/.codex-mr" },
    { vendor: "codex", machine: "PC", home: "H:/Archive/codex/b", source_home: "C:/Users/sample_a/.codex-mr" },
  ] };
  expect(probeArchiveSourceOf({ ...row, login: "sample_a", source_home: "C:/Users/sample_a/.codex-mr" }, ambiguous)).toBeNull();
});

test("the source resolves account periods at exact boundaries, corrections and gaps", () => {
  const row = { provider: "codex", machine: "PC", login: "sample_a", source_home: "C:/Users/sample_a/.codex-mr",
    subject: "stale-account", era_unattributed: 1 };
  const source = probeArchiveSourceOf(row, options);
  const period = (from: string, until: string | null, value: string, origin: DatedPeriod["origin"]): DatedPeriod => ({
    provider: "codex", subject: source!, from, until, value, origin,
    firstSeen: null, lastSeen: null, readings: 0, evidence: "test",
  });
  const resolver = buildAccountResolver([
    period("2026-09-01T08:00:00.000Z", "2026-09-01T10:00:00.000Z", "old", "observed"),
    period("2026-09-01T09:00:00.000Z", "2026-09-01T09:30:00.000Z", "corrected", "declared"),
    period("2026-09-01T12:00:00.000Z", null, "new", "observed"),
  ]);
  const resolve = (ts: string) => resolver.resolve("codex", source, null, ts);
  expect(resolve("2026-09-01T08:59:59.999Z")).toEqual({ account: "old", basis: "observed" });
  expect(resolve("2026-09-01T09:00:00.000Z")).toEqual({ account: "corrected", basis: "declared" });
  expect(resolve("2026-09-01T09:30:00.000Z")).toEqual({ account: "old", basis: "observed" });
  expect(resolve("2026-09-01T10:00:00.000Z")).toEqual({ account: null, basis: "gap" });
  expect(resolve("2026-09-01T12:00:00.000Z")).toEqual({ account: "new", basis: "observed" });
  expect(resolver.resolve("codex", null, null, "2026-09-01T12:00:00.000Z")).toEqual({ account: null, basis: "no-source" });
});

test("source lookup leaves the original row and canonical payload unchanged", () => {
  const row = { provider: "codex", subject: "original-account", raw_subject: "original-account",
    ts: "2026-09-01T09:00:00.000Z", kind: "primary", reported_percent_side: "used",
    machine: "PC", login: "sample_a", source_home: "C:/Users/sample_a/.codex-mr", era_unattributed: 1,
    extra: JSON.stringify({ home: "C:/Users/sample_a/.codex-mr", codex_account: { subscription: "observed-account" } }),
  };
  const before = JSON.stringify(row);
  const [fact] = createProbeCollection([row]);
  const payloadBefore = JSON.stringify(fact!.payload), digestBefore = fact!.payload_digest;
  expect(probeArchiveSourceOf(row, options)).toBe("codex/pc-agy11");
  expect(probeArchiveSourceOf({ ...fact!.payload, provider: String(fact!.payload.provider) }, options)).toBe("codex/pc-agy11");
  expect(JSON.stringify(row)).toBe(before);
  expect(JSON.stringify(fact!.payload)).toBe(payloadBefore);
  expect(fact!.payload_digest).toBe(digestBefore);
  expect(fact!.payload.subject).toBe("original-account");
  expect(fact!.payload.raw_subject).toBe("original-account");
});

test("GLM and OpenCode share the machine source contract, without account or home fallback", () => {
  for (const provider of ["glm", "opencode"]) {
    const row = { provider, machine: "WORKSTATION", subject: "stale-account", era_unattributed: 1 };
    expect(probeArchiveSourceOf(row, options)).toBe("glm/workstation");
    expect(probeArchiveSourceOf({ ...row, machine: null }, options)).toBeNull();
  }
  const resolver = buildAccountResolver([]);
  expect(resolver.resolve("glm", "glm/workstation", null, "2026-09-01T00:00:00Z"))
    .toEqual({ account: null, basis: "uncovered" });
  expect(resolver.resolve("glm", null, null, "2026-09-01T00:00:00Z"))
    .toEqual({ account: null, basis: "no-source" });
});

test("an Antigravity pool reading is taken in its worker's Windows account, not the probing process's", () => {
  const pool = (home: string, login: string) => ({ home, vendor_account: JSON.stringify({ id: "gemini-x",
    profiles: [{ vendor: "gemini", surface: "antigravity", machine: "PC", login, home }] }) });
  // The canonical payload carries the process login; the worker's profile decides.
  expect(probePhysicalProfileOf({ provider: "gemini", machine: "PC", login: "sample_a", profile: "agy08", extra: pool("pool:agy08", "agy08") }))
    .toEqual({ machine: "PC", home: "pool:agy08", login: "agy08" });
  expect(probeArchiveSourceOf({ provider: "gemini", machine: "PC", login: "sample_a", profile: "sample_a", extra: pool("pool:main", "sample_a") }, options))
    .toBe("gemini/pc-sample_a");
  // Without a discovery entry the reading's profile names the worker.
  expect(probeArchiveSourceOf({ provider: "gemini", machine: "PC", login: "sample_a", profile: "agy09", extra: { home: "pool:agy09" } }, options))
    .toBe("gemini/pc-agy09");
});
