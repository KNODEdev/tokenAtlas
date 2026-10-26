import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CycleSettingRow, CyclesResponse } from "../lib/api";
import { SCREEN_TITLES } from "../lib/screens";
import {
  appendCadenceDraftSegment,
  cadenceDraftFromRow,
  cadenceDraftPayload,
  createCadenceDraftIdFactory,
  patchCadenceDraftSegment,
  reduceCadenceSave,
  removeCadenceDraftSegment,
  type CadenceEditorState,
} from "./CyclesPanel";
import { groupRhythmRows, WindowRhythmsPanel } from "./WindowRhythmsPanel";

const groups = [{ id: "anthropic", label: "Anthropic", aliases: ["claude", "anthropic"] }];

const row = (part: Partial<CycleSettingRow> = {}): CycleSettingRow => ({
  subscription: "claude1",
  vendor: "claude",
  kind: "weekly",
  label: "Tydzień",
  period_hours: 168,
  period_source: "declared",
  anchor_ts: "2026-06-08T00:00:00.000Z",
  anchor_source: "declared",
  history_windows: 40,
  history_source: "declared",
  window_start: "2026-06-01T00:00:00.000Z",
  next_reset: "2026-06-08T00:00:00.000Z",
  history_available: 8,
  editable: { period: true, anchor: true, history: true },
  declaration_editable: true,
  effect: "Deklaracja ma pierwszeństwo; obserwowany fallback jest dowodem tylko do odczytu.",
  declared: true,
  note: null,
  segments: [
    {
      from: "2025-01-01",
      period_hours: 336,
      period_source: "declared",
      anchor_ts: "2026-05-18T00:00:00.000Z",
      anchor_source: "declared",
      history_windows: 20,
      note: "wcześniejszy rytm",
      source: "declared",
      declaration: true,
    },
    {
      from: "2026-06-01",
      period_hours: 168,
      period_source: "declared",
      anchor_ts: "2026-06-08T00:00:00.000Z",
      anchor_source: "declared",
      history_windows: 40,
      note: "zmiana rytmu",
      source: "declared",
      declaration: true,
    },
  ],
  ...part,
});

const response = (rows: CycleSettingRow[]): CyclesResponse => ({
  path: "cycles.json",
  default_history_windows: 40,
  min_history_period_hours: 24,
  rows,
});

function render(rows: CycleSettingRow[], asOf: string, initialSaveErrors?: Record<string, string>): string {
  return renderToStaticMarkup(
    <WindowRhythmsPanel
      data={response(rows)}
      asOf={asOf}
      provider="all"
      providerGroups={groups}
      defaultExpandedKeys={rows.map((item) => `${item.subscription}/${item.kind}`)}
      initialSaveErrors={initialSaveErrors}
      onSave={async () => ({ ok: true, rows })}
    />
  );
}

describe("WindowRhythmsPanel", () => {
  it("groups alias vendors by provider group, then stable Subscription and window kind", () => {
    const openaiGroups = [{ id: "openai", label: "OpenAI", aliases: ["codex", "openai"] }];
    const rows = [
      row({ subscription: "codex2", vendor: "openai", kind: "weekly" }),
      row({ subscription: "codex1", vendor: "codex", kind: "5h" }),
      row({ subscription: "codex1", vendor: "codex", kind: "weekly" }),
    ];
    const grouped = groupRhythmRows(rows, openaiGroups, "openai");
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.group.id).toBe("openai");
    expect(grouped[0]!.subscriptions.map((subscription) => subscription.id)).toEqual(["codex1", "codex2"]);
    expect(grouped[0]!.subscriptions[0]!.rows.map((item) => item.kind)).toEqual(["5h", "weekly"]);
    expect(groupRhythmRows(rows, openaiGroups, "anthropic")).toEqual([]);
  });

  it("selects the segment active on Stan na dzień and retains the complete ordered history", () => {
    const before = render([row()], "2026-05-31");
    const after = render([row()], "2026-06-01");

    expect(before).toContain('data-selected-segment="2025-01-01"');
    expect(after).toContain('data-selected-segment="2026-06-01"');
    expect((before.match(/data-history-segment=/g) ?? [])).toHaveLength(2);
    expect((after.match(/data-history-segment=/g) ?? [])).toHaveLength(2);
    expect(before).toContain('data-segment-from="2025-01-01" data-active="true"');
    expect(before).toContain('data-segment-from="2026-06-01" data-active="false"');
    expect(after).toContain('data-segment-from="2025-01-01" data-active="false"');
    expect(after).toContain('data-segment-from="2026-06-01" data-active="true"');
    expect(after).toContain("wcześniejszy rytm");
  });

  it("renders an undated legacy record as an explicit origin segment", () => {
    const legacy = row({
      subscription: "claude-legacy",
      segments: [
        {
          from: null,
          period_hours: 168,
          period_source: "declared",
          anchor_ts: "2026-06-08T00:00:00.000Z",
          anchor_source: "declared",
          history_windows: 40,
          note: "legacy bez daty",
          source: "declared",
          declaration: true,
        },
      ],
    });
    const html = render([legacy], "2024-01-01");
    expect(html).toContain('data-selected-segment="origin"');
    expect(html).toContain('data-segment-from="origin"');
    expect(html).toContain("origin (legacy)");
    expect(html).toContain("from the beginning of known history");
  });

  it("shows declared precedence and keeps observed fallback evidence read-only", () => {
    const declaredOverObserved = row({
      subscription: "claude-precedence",
      segments: [
        {
          from: null,
          period_hours: 336,
          period_source: "probe",
          anchor_ts: "2025-12-29T00:00:00.000Z",
          anchor_source: "probe",
          history_windows: 12,
          note: "observed fallback",
          source: "probe",
          declaration: false,
        },
        ...row().segments.slice(1),
      ],
    });
    const before = render([declaredOverObserved], "2025-12-31");
    const html = render([declaredOverObserved], "2026-08-01");
    const draft = cadenceDraftFromRow(declaredOverObserved);

    expect(before).toContain('data-selected-segment="observed-fallback"');
    expect(before).toContain('data-selected-source="probe"');
    expect(html).toContain('data-selected-source="declared"');
    expect(html).toContain('data-provenance="declared"');
    expect(html).toContain('data-provenance="probe"');
    expect(html).toContain("declaration");
    expect(html).toContain("observed (fallback)");
    expect(html).toContain("read-only");
    expect(draft).toHaveLength(1);
    expect(draft[0]!.from).toBe("2026-06-01");
  });

  it("keeps persisted declaration history editable when measurement-effect flags are false", () => {
    const measured = row({
      subscription: "codex-measured",
      vendor: "codex",
      editable: { period: false, anchor: false, history: false },
      declaration_editable: true,
    });
    const html = render([measured], "2026-08-01");

    expect(html).toContain('data-cadence-editor="codex-measured/weekly"');
    expect(html).toContain("save history");
    expect(html).toContain("remove");
    expect(html).not.toContain("Read-only declaration");
    expect(html).not.toContain(" disabled=\"\"");
  });

  it("keeps draft rows independent across add/add/remove/add", () => {
    const nextId = createCadenceDraftIdFactory();
    let draft = appendCadenceDraftSegment([], nextId(), "2026-01-01");
    draft = appendCadenceDraftSegment(draft, nextId(), "2026-02-01", draft[draft.length - 1]);
    const removedId = draft[0]!.id;
    draft = removeCadenceDraftSegment(draft, removedId);
    draft = appendCadenceDraftSegment(draft, nextId(), "2026-03-01", draft[draft.length - 1]);

    expect(draft.map((segment) => segment.id)).toEqual(["draft-1", "draft-2"]);
    expect(new Set(draft.map((segment) => segment.id)).size).toBe(draft.length);

    draft = patchCadenceDraftSegment(draft, "draft-1", { period: "120" });
    expect(draft.find((segment) => segment.id === "draft-1")?.period).toBe("120");
    expect(draft.find((segment) => segment.id === "draft-2")?.period).toBe("");
  });

  it("renders missing cadence as an em dash with a reason and never invents a segment", () => {
    const missing = row({
      subscription: "claude-missing",
      period_hours: null,
      period_source: "none",
      anchor_ts: null,
      anchor_source: "none",
      declared: false,
      segments: [],
    });
    const html = render([missing], "2026-08-01");
    expect(html).toContain('data-selected-segment="none"');
    expect(html).toContain("—");
    expect(html).toContain("no declared or observed cadence");
    expect(html).not.toContain('data-history-segment="claude-missing/weekly');
  });

  it("preserves the whole draft and shows a server refusal verbatim", () => {
    const current = row();
    const draft = cadenceDraftFromRow(current);
    const initial: CadenceEditorState = { draft, error: null };
    const refusal = "claude1/weekly: duplicate from '2026-06-01'";
    const refused = reduceCadenceSave(initial, { ok: false, error: refusal });
    expect(refused.draft).toEqual(draft);
    expect(refused.error).toBe(refusal);

    const payload = cadenceDraftPayload(current.subscription, current.kind, refused.draft);
    expect("segments" in payload && payload.segments).toHaveLength(2);

    const html = render([current], "2026-08-01", { "claude1/weekly": refusal });
    expect(html).toContain('data-save-error="1"');
    expect(html.replaceAll("&#x27;", "'")).toContain(refusal);
    expect(html).toContain('data-draft-count="2"');
    expect((html.match(/data-draft-segment=/g) ?? [])).toHaveLength(2);
  });

  it("does not extend a dated first declaration backward before its from", () => {
    const dated = row({
      segments: [
        {
          from: "2026-06-01",
          period_hours: 168,
          period_source: "declared",
          anchor_ts: "2026-06-08T00:00:00.000Z",
          anchor_source: "declared",
          history_windows: 40,
          note: null,
          source: "declared",
          declaration: true,
        },
      ],
    });
    const html = render([dated], "2026-05-31");
    expect(html).toContain('data-selected-segment="none"');
    expect(html).toContain("the first interval starts 2026-06-01");
    expect(html).not.toContain('data-selected-segment="2026-06-01"');
  });

  it("routes cadence guidance to Settings after Sources extraction", async () => {
    const header = await Bun.file("src/web/components/AppHeader.tsx").text();
    const history = await Bun.file("src/web/screens/WindowHistory.tsx").text();

    expect(header).toMatch(/label=\{t\("Settings", "Ustawienia"\)\}[\s\S]{0,240}goto\("settings"\)/);
    expect(header).not.toMatch(/label="Ustawienia"[\s\S]{0,180}goto\("sources"\)/);
    expect(history).toContain("Ustawienia → Konta → Rytm okien");
    expect(history).not.toContain("ekranie Data sources");
    expect(SCREEN_TITLES.sources).toBe("Data sources");
  });

  it("ships all five design-sync fixtures without hand-wrapping ThemeSurface", async () => {
    const preview = await Bun.file(".design-sync/previews/WindowRhythmsPanel.tsx").text();
    for (const fixture of ["LegacyOrigin", "DeclaredOverObserved", "CadenceChange", "MissingCadence", "ServerRefusal"]) {
      expect(preview).toContain(`export const ${fixture}`);
    }
    expect(preview).not.toContain("<ThemeSurface");
    const config = await Bun.file(".design-sync/config.json").json();
    expect(config.overrides.WindowRhythmsPanel.primaryStory).toBe("CadenceChange");
  });
});
