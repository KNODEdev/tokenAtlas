import type { ProgressUnit } from "../shared/progress";
import type { SyncPhase } from "../shared/sync-progress";
import type { VendorId, SyncRunResult, VendorPhaseTimings } from "./contracts";
import type { ProgressRegistry } from "./progress";

/** The validation steps a vendor's stage goes through, as the progress register names them. */
export type ValidationStep = "sources" | "identities" | "repos" | "gaps" | "projects" | "rules" | "integrity" | "timestamps";

export const VALIDATION_LABELS: Record<ValidationStep, string> = {
  sources: "Checking source coverage", identities: "Preserving source identities", repos: "Assigning repositories",
  gaps: "Calculating gaps between calls", projects: "Assigning projects", rules: "Saving calculation rules",
  integrity: "Checking database structure", timestamps: "Checking event dates",
};

/** The publication steps of a vendor; only `write` and `indexes` have a measurable amount. */
type PublicationStep = "compare" | "write" | "finalize" | "indexes" | "commit";

export type PublicationReport = (operation: PublicationStep, completed?: number, total?: number) => void;

export const PUBLICATION_STEPS: Record<PublicationStep, { label: string; unit: ProgressUnit }> = {
  compare: { label: "Comparing source records", unit: "records" }, write: { label: "Transferring records", unit: "records" },
  finalize: { label: "Saving the change summary", unit: "items" }, indexes: { label: "Building indexes", unit: "indexes" },
  commit: { label: "Committing the result", unit: "items" },
};

export const PHASE_LABELS: Record<SyncPhase, string> = {
  readings: "Reading current account limits", scan: "Looking for changed files", identity: "Checking account assignments",
  mirror: "Copying source files", stage: "Preparing the import", ingest: "Indexing history", validate: "Validating imported data",
  publish: "Saving imported data", attribution: "Assigning usage to accounts", projects: "Updating project assignments",
  checkpoint: "Flushing database changes", finalize: "Publishing account state",
};

export const RUN_SCOPE = "sync";

export const vendorScope = (vendor: VendorId) => `${RUN_SCOPE}:${vendor}`;

export function createVendorTelemetry({ result, outcome, scope, discoveryTimings, discoverySteps: vendorDiscoverySteps,
  progressRegister, saveStatusWithoutWaiting }: {
  result: SyncRunResult;
  outcome: SyncRunResult["vendors"][number];
  scope: string;
  discoveryTimings: ReadonlyMap<VendorId, number>;
  discoverySteps: ReadonlyMap<VendorId, Record<string, number>>;
  progressRegister: Pick<ProgressRegistry, "report">;
  saveStatusWithoutWaiting: (result: SyncRunResult) => void;
}) {
  // Transaction work is visible in the register before its results commit.
  const publicationProgress: { report: PublicationReport } = {
    report: (operation, completed, total) => {
      const step = PUBLICATION_STEPS[operation];
      progressRegister.report(scope, `publish.${operation}`, step.label, step.unit, completed ?? 0, total ?? null);
    },
  };
  // Long publication steps name themselves in the progress panel.
  const measurePublication = <T>(name: string, work: () => T): T => {
    if (name === "indexBuildMs") publicationProgress.report("indexes");
    else if (name === "changeClocksMs" || name === "probeFactLinksMs") publicationProgress.report("finalize");
    return measureTiming(name, work);
  };
  const timings = outcome.timings ?? { mirrorMs: 0, stageMs: 0, ingestMs: 0, publishMs: 0 };
  outcome.timings = timings;
  timings.discoveryMs=discoveryTimings.get(outcome.vendor);
  const discoverySteps=vendorDiscoverySteps.get(outcome.vendor);
  if(discoverySteps)timings.steps={...timings.steps,...discoverySteps};
  const phase = (field: keyof Pick<VendorPhaseTimings, "mirrorMs" | "stageMs" | "ingestMs" | "publishMs">, started: number) => {
    timings[field] += Math.round(performance.now() - started);
  };
  // Optional telemetry must never change the outcome of a source run.
  const timingStart = (): number | undefined => {
    try { return performance.now(); } catch { return undefined; }
  };
  const timingEnd = (field: keyof Omit<VendorPhaseTimings, "mirrorMs" | "stageMs" | "ingestMs" | "publishMs" | "steps">, started: number | undefined) => {
    if (started === undefined) return;
    try {
      const elapsed = performance.now() - started;
      if (Number.isFinite(elapsed) && elapsed >= 0) timings[field] = Math.round(elapsed);
    } catch { /* Timing is advisory. */ }
  };
  const measureTiming = <T>(name:string,work:()=>T):T => {
    const started=performance.now();
    outcome.diagnostics.activeTimingStep={name,startedAt:Date.now()};
    try{saveStatusWithoutWaiting(result);}catch{/* Advisory progress. */}
    try{return work();}finally{
      (timings.steps??={})[name]=(timings.steps?.[name]??0)+Math.round(performance.now()-started);
      delete outcome.diagnostics.activeTimingStep;
      try{saveStatusWithoutWaiting(result);}catch{/* The next phase persists timings. */}
    }
  };
  return { timings, phase, timingStart, timingEnd, measureTiming, measurePublication, publicationProgress };
}

export type VendorTelemetry = ReturnType<typeof createVendorTelemetry>;
