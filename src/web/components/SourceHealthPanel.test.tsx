import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { initialSourceProfileEdit, sourceRowGroup, sourceSettingsData, SourceHealthTable, subscriptionTone } from "./SourceHealthPanel";
import type { SourceHealthResponse, SourceHealthRow, SourceProfileConfiguration } from "../../shared/source-health";

const row: SourceHealthRow = { key: "laptop", subscription: "kuba", vendor: "codex", label: "Kuba", machine: "LAPTOP",
  profile: "C:/Users/sample_a/.codex-mr", archive: null, configured: false, historical: false, local: true,
  last_session: null, last_meter: "2026-09-15T11:00:00Z", last_attempt: "2026-09-15T11:00:00Z", error: null, status: "missing-assignment" };

test("one subscription shows its assigned PCs with ages and folds profiles detected without assignment", () => {
  const data: SourceHealthResponse = { generated_at: "2026-09-15T12:00:00Z", local_machine: "LAPTOP", older_after_hours: 24,
    sources: [{ ...row, key: "main", machine: "MAIN", local: false, archive: "C:/archive/MAIN-agy11", configured: true, status: "older", last_session: "2026-09-13T10:00:00Z" }, row] };
  const html = renderToStaticMarkup(<SourceHealthTable data={data} />);
  expect(html).toContain("MAIN-agy11");
  expect(html).toContain("Latest data"); expect(html).toContain("Profile location");
  expect(html).toContain("Assigned · 1"); expect(html).toContain("Other computer");
  // Age instead of a full date; the exact instant is the tooltip.
  expect(html).toMatch(/class="source-age" title="[^"]+"><i[^>]*><\/i>Sessions: \d+ days ago/);
  // The rail names the subscription's computers and state; the sheet's facts repeat them with what they rest on.
  expect(html).toContain("<b>1 computer</b> · older data");
  expect(html).toContain('title="1 profile detected without assignment">1 profile detected');
  expect(html).toMatch(/data-fact="computers"><dt>Assigned computers<\/dt><dd class="ui-fact-value"><strong>1<\/strong><\/dd><dd class="ui-fact-note">MAIN<\/dd>/);
  expect(html).toContain('data-fact="detected"');
  expect(html).toMatch(/<button type="button" class="ui-disclosure" aria-expanded="false">▸ Detected without assignment · 1<\/button>/);
  expect(html).not.toContain('data-source-machine="LAPTOP"');
  expect((html.match(/<table /g) ?? []).length).toBe(1);
  expect(html).toContain("Subscription to configure");
});

test("rows split into assigned, detected and traces; detections are offered for assignment when nothing is assigned", () => {
  expect(sourceRowGroup({ ...row, configured: true })).toBe("assigned");
  expect(sourceRowGroup(row)).toBe("detected");
  expect(sourceRowGroup({ ...row, machine: null })).toBe("trace");
  expect(subscriptionTone([{ ...row, status: "error" }])).toBe("neutral");
  expect(subscriptionTone([{ ...row, configured: true, status: "current" }, row])).toBe("ok");
  const data: SourceHealthResponse = { generated_at: "2026-09-15T12:00:00Z", local_machine: "LAPTOP", older_after_hours: 24,
    sources: [row, { ...row, key: "trace", machine: null, profile: null, local: false, last_session: "2026-09-10T08:00:00Z", status: "unknown" }] };
  const html = renderToStaticMarkup(<SourceHealthTable data={data} />);
  expect(html).toContain('data-source-machine="LAPTOP"');
  expect(html).toMatch(/aria-expanded="false"[^>]*>Assign<\/button>/);
  expect(html).toContain("Missing assignment");
  expect(html).toContain("▸ Traces without a computer · 1");
  expect(html).toContain("sessions until");
  expect(html).not.toContain('data-source-machine="unknown"');
});

test("the picker files every provider's unassigned profiles under one heading at the end, with status dots", async () => {
  const { groupSourceSubscriptions } = await import("./SourceSubscriptionPicker");
  const unassigned = { id: "unassigned", label: "Unassigned profiles" };
  const groups = groupSourceSubscriptions([
    { value: "codex:unassigned", vendor: "codex", label: "Codex", group: unassigned },
    { value: "codex:c1", vendor: "codex", label: "codex1", tone: "ok" },
    { value: "claude:unassigned", vendor: "claude", label: "Claude", group: unassigned },
    { value: "gemini:g1", vendor: "gemini", label: "g1", tone: "crit" },
  ]);
  expect(groups.map((group) => group.label)).toEqual(["Codex", "Gemini", "Unassigned profiles"]);
  expect(groups.at(-1)!.options.map((option) => option.label)).toEqual(["Claude", "Codex"]);
});

test("configuration remains editable before reports and supersedes a stale missing assignment", () => {
  const inventory: SourceHealthResponse = { generated_at: "now", local_machine: "LAPTOP", older_after_hours: 24,
    activity_pending: true, sources: [{ ...row, configured: true, archive: "C:/archive/laptop", status: "configured" }] };
  const merged = sourceSettingsData(inventory, { ...inventory, sources: [row] });
  expect(merged.sources).toHaveLength(1);
  expect(merged.sources[0]).toMatchObject({ configured: true, status: "configured", activity_pending: true });
  const html = renderToStaticMarkup(<SourceHealthTable data={sourceSettingsData(inventory)} />);
  expect(html).toContain(">Edit</button>"); expect(html).not.toContain("No data");
});

test("known ages show while the server still prepares limit readings; a missing one says so", () => {
  const pending: SourceHealthResponse = { generated_at: "2026-09-15T12:00:00Z", local_machine: "LAPTOP", older_after_hours: 24, activity_pending: true,
    sources: [{ ...row, configured: true, archive: "C:/archive/laptop", status: "current", activity_pending: true, last_session: "2026-09-13T10:00:00Z", last_meter: null }] };
  const html = renderToStaticMarkup(<SourceHealthTable data={pending} />);
  expect(html).toMatch(/Sessions: \d+ days ago/);
  expect(html).toContain("Limit: no data yet");
  expect(html).not.toContain("…");
  // A route the health report does not mention has no activity once the report is in.
  const inventory: SourceHealthResponse = { ...pending, activity_pending: true, sources: [{ ...row, configured: true, archive: "C:/archive/laptop", status: "configured" }] };
  const merged = sourceSettingsData(inventory, { ...inventory, activity_pending: false, sources: [] });
  expect(merged.sources[0]!.activity_pending).toBe(false);
  expect(sourceSettingsData(inventory).sources[0]!.activity_pending).toBe(true);
});

test("missing laptop assignment creates an additional source instead of moving MAIN", () => {
  const config: SourceProfileConfiguration = { revision: "v1", machine: "LAPTOP", login: "sample_a",
    declarations: [{ vendor: "codex", machine: "MAIN", home: "${ARCHIVE}/codex/MAIN-agy11", source_home: row.profile! }],
    resolved: [{ archive: "C:/archive/MAIN-agy11", profile: row.profile }] };
  expect(initialSourceProfileEdit(config, row)).toMatchObject({ index: null, subscription: "kuba", profile: row.profile });
});

test("a configured source remains editable during an unassigned account period", () => {
  const source = { ...row, subscription: "unassigned", configured: true, archive: "C:/archive/laptop", status: "configured" as const };
  const data: SourceHealthResponse = { generated_at: "now", local_machine: "LAPTOP", older_after_hours: 24, sources: [source] };
  const html = renderToStaticMarkup(<SourceHealthTable data={data} />);
  expect(html).toContain(">Edit</button>");
  const config: SourceProfileConfiguration = { revision: "v2", machine: "LAPTOP", login: "sample_a",
    declarations: [{ vendor: "codex", machine: "LAPTOP", home: "C:/archive/laptop", source_home: row.profile! }],
    resolved: [{ archive: "C:/archive/laptop", profile: row.profile }] };
  expect(initialSourceProfileEdit(config, source)).toMatchObject({ index: 0, subscription: "", profile: row.profile });
});

test("provider dropdown groups interleaved accounts and keeps all same-provider profile choices", async () => {
  const { groupSourceSubscriptions } = await import("./SourceSubscriptionPicker");
  const { profileOptions } = await import("./SourceHealthPanel");
  expect(groupSourceSubscriptions([
    { value: "c2", vendor: "codex", label: "Z" }, { value: "g1", vendor: "gemini", label: "AGY" },
    { value: "c1", vendor: "codex", label: "A" }, { value: "a1", vendor: "claude", label: "Claude" },
  ]).map(group => group.options.map(option => option.value))).toEqual([["c1", "c2"], ["a1"], ["g1"]]);
  const config: SourceProfileConfiguration = { revision: "v1", machine: "LAPTOP", login: "user", declarations: [], resolved: [], detected_profiles: [
    { vendor: "gemini", home: "pool:agy1", name: "agy1", kind: "managed", account: "account_0000@example.test", error: null },
    { vendor: "claude", home: "C:/.claude", name: ".claude", kind: "folder", account: null, error: null },
    ...[".codex", ".codex-mr", ".codex-other"].map(name => ({ vendor: "codex", home: `C:/${name}`, name, kind: "folder" as const, account: `${name}@example.test`, error: null })),
  ] };
  const options = profileOptions(config, row);
  expect(options).toHaveLength(3);
  expect(options[1]).toMatchObject({ value: "C:/.codex-mr", label: ".codex-mr · .codex-mr@example.test", detail: "C:/.codex-mr" });
  expect(profileOptions(config, { ...row, vendor: "gemini" })).toEqual([]);
  expect(profileOptions({ ...config, detected_profiles: undefined }, { ...row, vendor: "gemini" }, ["pool:agy1"])).toEqual([]);
});

test("assigning an implicit default profile keeps its existing archive partition", () => {
  const config: SourceProfileConfiguration = { revision: "v1", machine: "LAPTOP", login: "sample_a", declarations: [], resolved: [] };
  for (const vendor of ["codex", "claude", "grok", "gemini"]) {
    expect(initialSourceProfileEdit(config, { ...row, vendor, profile: `C:/Users/sample_a/.${vendor}` }).archive)
      .toBe(`\${ARCHIVE}/${vendor}/${vendor === "claude" ? "LAPTOP" : "LAPTOP-sample_a"}`);
  }
});
