import type { CodexComparisonWindow } from "../shared/codex-accounting";
import type { WindowEvidence } from "../shared/subscription-quality";
import type { EraIndex } from "./eras";
import { normEraKey, normEraVendor } from "./eras";
import type { Database } from "bun:sqlite";
import { loadSubscriptionImportEvidence, importEvidenceForWindow } from "./subscription-import-evidence";

export function emptyWindowEvidence(): WindowEvidence {
  return { archive_completeness: "unconfirmed", mode_relevant: true, meter_gaps: [], sources: [], declared_sources: [],
    excluded_events: { counter: 0, plan: 0, reset: 0 } };
}

/** Declarations establish expected sources, not proof that every request was recorded. */
export function attachWindowEvidence(windows: CodexComparisonWindow[] | null, context: { provider: string; eras?: EraIndex; modeRelevant?: boolean; opaqueSources?: readonly string[]; sqlite?: Database }): void {
  const imports = context.sqlite && windows?.length ? loadSubscriptionImportEvidence(context.sqlite, context.provider) : null;
  for (const window of windows ?? []) {
    const evidence = window.evidence ??= emptyWindowEvidence();
    evidence.mode_relevant = context.modeRelevant ?? context.provider === "codex";
    const start = window.cycle_start ?? window.start, end = window.cycle_end ?? window.reset;
    if (imports) evidence.imports = importEvidenceForWindow(imports, start, end);
    const declared = new Map<string, WindowEvidence["declared_sources"][number]>();
    const eras = (context.eras?.entriesOf(window.account) ?? []).filter(era => normEraVendor(era.vendor) === normEraVendor(context.provider)
      && (!era.from || Date.parse(era.from) < Date.parse(end)) && (!era.until || Date.parse(era.until) > Date.parse(start)));
    const physicalSources = new Set(eras.flatMap(era => era.source_home || era.home ? [normEraKey(era.source_home || era.home)] : []));
    // Store labels can aggregate several machines; current paths cannot resolve historical origin.
    const opaqueSources = new Set(context.opaqueSources?.map(normEraKey));
    const opaqueTraffic = evidence.sources.some(s => opaqueSources.has(normEraKey(s.name)));
    for (const era of eras) {
      const aliases = [era.source_home, era.home].filter((s): s is string => !!s).map(normEraKey);
      if (!aliases.length) continue;
      const name = era.source_home || era.home!;
      const physical = evidence.sources.some(s => aliases.includes(normEraKey(s.name)));
      const accountNamed = evidence.sources.some(s => normEraKey(s.name) === normEraKey(era.id));
      const observed = physical ? true : opaqueTraffic ? null : accountNamed ? physicalSources.size === 1 ? true : null : false;
      const key = JSON.stringify([normEraKey(name), era.from, era.until]);
      declared.set(key, { name, observed, ...(era.from ? { from: era.from } : {}), ...(era.until ? { until: era.until } : {}) });
    }
    evidence.declared_sources = [...declared.values()];
  }
}
