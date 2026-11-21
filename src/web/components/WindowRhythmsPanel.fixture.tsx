import { WindowRhythmsPanel } from "./WindowRhythmsPanel";
import type { CycleSettingRow, CyclesResponse } from "../lib/api";
const providerGroups = [
  { id: "openai", label: "OpenAI", aliases: ["codex", "openai"] },
  { id: "anthropic", label: "Anthropic", aliases: ["claude", "anthropic"] },
];
const baseRow = (part: Partial<CycleSettingRow>): CycleSettingRow => ({
  subscription: "claude1",
  vendor: "claude",
  kind: "weekly",
  label: "Tydzień",
  period_hours: 168,
  period_source: "declared",
  anchor_ts: "2026-08-31T11:00:00.000Z",
  anchor_source: "declared",
  history_windows: 40,
  history_source: "declared",
  window_start: "2026-08-24T11:00:00.000Z",
  next_reset: "2026-08-31T11:00:00.000Z",
  history_available: 12,
  editable: { period: true, anchor: true, history: true },
  declaration_editable: true,
  effect: "Deklaracja wyznacza syntetyczne granice; obserwacje pozostają dowodem tylko do odczytu.",
  declared: true,
  note: null,
  segments: [],
  ...part,
});
const response = (rows: CycleSettingRow[]): CyclesResponse => ({
  path: "cycles.json",
  default_history_windows: 40,
  min_history_period_hours: 24,
  rows,
});
const saveFor = (rows: CycleSettingRow[]) => async () => ({ ok: true as const, rows });
const legacy = baseRow({
  subscription: "claude-legacy",
  segments: [
    {
      from: null,
      period_hours: 168,
      period_source: "declared",
      anchor_ts: "2026-08-31T11:00:00.000Z",
      anchor_source: "declared",
      history_windows: 40,
      note: "Wczytane bez przepisywania rekordu legacy.",
      source: "declared",
      declaration: true,
    },
  ],
});
const declaredOverObserved = baseRow({
  subscription: "claude-pro",
  note: "Deklaracja ma pierwszeństwo przed obserwowanym fallbackiem.",
  effect: "Deklaracja ma pierwszeństwo w pokrywanym dniu; probe pozostaje dowodem tylko do odczytu.",
  segments: [
    {
      from: null,
      period_hours: 336,
      period_source: "probe",
      anchor_ts: "2025-12-29T11:00:00.000Z",
      anchor_source: "probe",
      history_windows: 12,
      note: "Zaobserwowany fallback sprzed pierwszej deklaracji — tylko do odczytu.",
      source: "probe",
      declaration: false,
    },
    {
      from: "2026-01-01",
      period_hours: 168,
      period_source: "declared",
      anchor_ts: "2026-08-31T11:00:00.000Z",
      anchor_source: "declared",
      history_windows: 40,
      note: "Deklaracja wybrana zamiast obserwowanego fallbacku.",
      source: "declared",
      declaration: true,
    },
  ],
});
const changed = baseRow({
  subscription: "claude-change",
  period_hours: 168,
  segments: [
    {
      from: "2025-01-01",
      period_hours: 336,
      period_source: "declared",
      anchor_ts: "2026-05-18T00:00:00.000Z",
      anchor_source: "declared",
      history_windows: 20,
      note: "Starsze okna zachowują rytm dwutygodniowy.",
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
      note: "Nowy tygodniowy rytm od jawnej granicy.",
      source: "declared",
      declaration: true,
    },
  ],
});
const missing = baseRow({
  subscription: "claude-missing",
  period_hours: null,
  period_source: "none",
  anchor_ts: null,
  anchor_source: "none",
  declared: false,
  segments: [],
});
export const LegacyOrigin = () => (
  <WindowRhythmsPanel
    data={response([legacy])}
    asOf="2026-08-29"
    provider="all"
    providerGroups={providerGroups}
    defaultExpandedKeys={["claude-legacy/weekly"]}
    onSave={saveFor([legacy])}
  />
);
export const DeclaredOverObserved = () => (
  <WindowRhythmsPanel
    data={response([declaredOverObserved])}
    asOf="2026-08-29"
    provider="anthropic"
    providerGroups={providerGroups}
    defaultExpandedKeys={["claude-pro/weekly"]}
    onSave={saveFor([declaredOverObserved])}
  />
);
export const CadenceChange = () => (
  <WindowRhythmsPanel
    data={response([changed])}
    asOf="2026-08-29"
    provider="all"
    providerGroups={providerGroups}
    defaultExpandedKeys={["claude-change/weekly"]}
    onSave={saveFor([changed])}
  />
);
export const MissingCadence = () => (
  <WindowRhythmsPanel
    data={response([missing])}
    asOf="2026-08-29"
    provider="all"
    providerGroups={providerGroups}
    defaultExpandedKeys={["claude-missing/weekly"]}
    onSave={saveFor([missing])}
  />
);
export const ServerRefusal = () => (
  <WindowRhythmsPanel
    data={response([changed])}
    asOf="2026-08-29"
    provider="all"
    providerGroups={providerGroups}
    defaultExpandedKeys={["claude-change/weekly"]}
    initialSaveErrors={{
      "claude-change/weekly": "claude-change/weekly: duplicate from '2026-06-01'",
    }}
    onSave={async () => {
      throw new Error("claude-change/weekly: duplicate from '2026-06-01'");
    }}
  />
);
