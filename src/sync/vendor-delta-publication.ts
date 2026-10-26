import type { VendorTelemetry } from "./vendor-progress";
import type { Database } from "../db/sqlite";
import type { DeltaIdentity } from "./vendor-publication-schema";
import { vendorIdentityFingerprints, DELTA_SPECS, VENDOR_TABLES, ROW_DIFF_VENDORS } from "./vendor-publication-schema";
import { reparseIdentities, preserveReparseOutsideRange } from "./reparse";
import { collectDeltaIdentities, identityKey, mergeDirtyRanges, identityTimestampRange } from "./publication-identities";
import { readAccountsV2 } from "../config/accounts-document";
import { configFile } from "../config/paths";
import { quoteIdentifier } from "./sync-sql";
import { dirtyRangesFromTimestamps } from "./dirty-ranges";
import { isUsageVendor } from "./contracts";
import { accountReparseOwnershipStamp, accountReparseSelection } from "./account-selection";
import { loadAccountResolver } from "../server/account-resolver";
import { measureTimestampDifferences } from "./timestamp-difference";
import type { BookmarkState, BookmarkOutcome } from "./stage-bookmarks";
import { readBookmarkState, nullableTableColumns, hasReadBookmark, writeBookmarkState, unreadBookmark } from "./stage-bookmarks";
import { publishIncrementalDelta } from "./incremental-publication";
import { saveAcceptedFacts } from "./accepted-facts";
import type { StagePublicationServices, StagePublicationWork, PreparedPublicationFacts } from "./vendor-stage-publication";

export function publishVendorDelta(
  services: StagePublicationServices,
  work: StagePublicationWork,
  telemetry: VendorTelemetry,
  comparison: {
    stage: Database;
    preparedFacts: PreparedPublicationFacts | undefined;
    recordProjectRules: () => void;
    startComparison: () => void;
    finishComparison: () => void;
  },
): void {
  const { sqlite, store, now, saveRun, options, queuedFiles } = services;
  const { result, outcome, priorReparse, publicationState, saveCompletedSourceBookmark } = work;
  const { changedFiles, adapter, reparsePlan } = work.prepared;
  const { timingStart, timingEnd, publicationProgress } = telemetry;
  const { stage, recordProjectRules, startComparison, finishComparison } = comparison;
  let { preparedFacts } = comparison;
  startComparison();
  const detected = preparedFacts?.identities ?? collectDeltaIdentities(sqlite, stage, outcome.vendor,changedFiles);
  let identities = preparedFacts?.identities ?? (reparsePlan
    ? reparseIdentities(DELTA_SPECS[outcome.vendor], detected, reparsePlan)
    : detected);
  let accountAccepted: Map<string,string> | undefined;
  let accountOwners: unknown;
  // Publication must still use the ownership against which selection was prepared.
  const accountOwnerEvidence = () => result.scope.kind !== "accounts" || !isUsageVendor(outcome.vendor) ? null
    : accountReparseOwnershipStamp(loadAccountResolver(sqlite, readAccountsV2(configFile("accounts.json")).subscriptions), outcome.vendor, result.scope.accounts, reparsePlan?.bounds);
  if (reparsePlan && result.scope.kind === "accounts") {
    if (!isUsageVendor(outcome.vendor)) throw new Error("Account rebuild does not import gauge journals");
    const declarations = readAccountsV2(configFile("accounts.json"));
    reparsePlan.selection = accountReparseSelection(sqlite, stage, outcome.vendor,
      result.scope.accounts, loadAccountResolver(sqlite, declarations.subscriptions),
      DELTA_SPECS[outcome.vendor], identities, declarations);
    reparsePlan.onReconciled = selected => {
      accountAccepted = vendorIdentityFingerprints(sqlite, outcome.vendor, selected).byIdentity;
      accountOwners = accountOwnerEvidence();
    };
  }
  const bounded = !!(reparsePlan?.bounds || reparsePlan?.selection);
  if (reparsePlan && bounded) {
    // A whole-source match needs no semantic closure or restoration of outside rows.
    // Account ownership still requires its separate selection proof.
    const unchanged = new Set<string>();
    if (!reparsePlan.selection) {
      const before = preparedFacts?.active.byIdentity ?? vendorIdentityFingerprints(sqlite, outcome.vendor, identities, true, true).byIdentity;
      const after = preparedFacts?.staged.byIdentity ?? vendorIdentityFingerprints(stage, outcome.vendor, identities).byIdentity;
      for (const identity of identities) {
        const key = identityKey(DELTA_SPECS[outcome.vendor], identity);
        if (before.get(key) === after.get(key)) unchanged.add(key);
      }
    }
    const retained = identities.filter(identity => unchanged.has(identityKey(DELTA_SPECS[outcome.vendor], identity)));
    const reconcile = identities.filter(identity => !unchanged.has(identityKey(DELTA_SPECS[outcome.vendor], identity)));
    if (reconcile.length) preparedFacts = undefined;
    const wholeCodexFacts = outcome.vendor === "codex" && reconcile.length
      ? vendorIdentityFingerprints(stage, "codex", reconcile, false).byIdentity : null;
    let reconciled: DeltaIdentity[] = [];
    try { reconciled = reconcile.length ? preserveReparseOutsideRange(
      sqlite, stage, DELTA_SPECS[outcome.vendor], VENDOR_TABLES[outcome.vendor].data,
      reconcile, reparsePlan) : []; }
    finally { (reparsePlan.selection as ReturnType<typeof accountReparseSelection> | undefined)?.dispose(); }
    identities = [...new Map([...retained, ...reconciled].map(identity =>
      [identityKey(DELTA_SPECS[outcome.vendor], identity), identity])).values()];
    if (wholeCodexFacts) {
      const finalFacts = vendorIdentityFingerprints(stage, "codex", reconciled, false).byIdentity;
      // A hybrid of preserved and newly parsed rows has no verified whole-file source proof.
      for (const identity of reconciled) {
        const key = identityKey(DELTA_SPECS.codex, identity);
        if (wholeCodexFacts.get(key) === finalFacts.get(key)) continue;
        for (const table of VENDOR_TABLES.codex.evidence!) stage.query(`DELETE FROM ${quoteIdentifier(table)} WHERE home=? AND path=?`)
          .run(identity.home!, identity.path!);
      }
    }
    if (reparsePlan.selection) outcome.diagnostics = {...outcome.diagnostics, reparse: {
      ...(outcome.diagnostics.reparse as Record<string, unknown>),
      selectedDays: [...(reparsePlan.selectedDays ?? [])].sort(),
      accountScope: "usage-with-existing-meters",
    }};
    // These sources prove no semantic coordinate, so they keep every accepted
    // fact instead of being rewritten; recovering them needs their own run.
    if (reparsePlan.ambiguous?.length) {
      const prior = outcome.diagnostics.reparse && typeof outcome.diagnostics.reparse === "object"
        ? outcome.diagnostics.reparse as Record<string, unknown> : {};
      outcome.diagnostics = { ...outcome.diagnostics,
        reparse: { ...prior, ambiguous: reparsePlan.ambiguous } };
      throw new Error(`Ranged ${outcome.vendor} reparse cannot prove source coordinates for ${reparsePlan.ambiguous.length} required sources; no source facts were published`);
    }
  }
  if (identities.length === 0) {
    const unbounded = reparsePlan?.ambiguous?.length
      ? `; ranged reparse could not bound ${reparsePlan.ambiguous.map((identity) => JSON.stringify(identity)).join(", ")}, whose accepted facts were kept`
      : "";
    throw new Error(`${outcome.vendor} incremental adapter produced no affected identities${unbounded}`);
  }
  const activeFacts = preparedFacts?.active ?? vendorIdentityFingerprints(sqlite, outcome.vendor, identities, true, true);
  const stagedFacts = preparedFacts?.staged ?? vendorIdentityFingerprints(stage, outcome.vendor, identities);
  const changedIdentities=identities.filter(identity=> {
    const key=identityKey(DELTA_SPECS[outcome.vendor],identity);
    return activeFacts.byIdentity.get(key)!==stagedFacts.byIdentity.get(key);
  });
  const changedTimestamps:string[]=[];
  const changedRanges = measureTimestampDifferences(sqlite,stage,{
    identity:DELTA_SPECS[outcome.vendor].identity,tables:VENDOR_TABLES[outcome.vendor].data,
  },changedIdentities,ts=>changedTimestamps.push(ts));
  outcome.dirtyRanges=dirtyRangesFromTimestamps(changedTimestamps);
  // A bounded publication reports only what it actually moved. An identity
  // without a measured window is unknown - never an empty change.
  const rangedDirtyRange = (changed: DeltaIdentity[]) => {
    const keys = changed.map(identity => identityKey(DELTA_SPECS[outcome.vendor], identity));
    return keys.some(key => !changedRanges.has(key)) ? null
      : mergeDirtyRanges(...keys.map(key => changedRanges.get(key)!));
  };
  outcome.dataChanged = changedIdentities.length>0;
  const oldRange = identityTimestampRange(sqlite, outcome.vendor, changedIdentities);
  const newRange = identityTimestampRange(stage, outcome.vendor, changedIdentities);
  outcome.dirtyRange = outcome.dataChanged
    ? bounded
      ? rangedDirtyRange(changedIdentities)
      : mergeDirtyRanges(adapter.dirtyRange, oldRange, newRange)
    : null;
  outcome.diagnostics = {
    ...outcome.diagnostics,
    deltaIdentities: identities.length,
    changedIdentities: changedIdentities.length,
    beforeFingerprint: activeFacts.fingerprint,
    afterFingerprint: stagedFacts.fingerprint,
  };
  const spec = DELTA_SPECS[outcome.vendor];
  // Captured under the publication lock, before any mutation: the
  // accepted reading position and the facts it is a witness of.
  let accepted = new Map<string, BookmarkState>();
  let acceptedFacts = new Map<string, string>();
  const stagedBookmarks = new Map(identities.map(identity =>
    [identityKey(spec, identity), readBookmarkState(stage, spec, identity)]));
  const resolveRangedBookmarks = () => {
    if (!reparsePlan || !bounded) return;
    const finalFacts = vendorIdentityFingerprints(sqlite, outcome.vendor, identities, true, true).byIdentity;
    const nullableColumns = spec.bookmarkTable
      ? nullableTableColumns(sqlite, spec.bookmarkTable) : new Set<string>();
    const tally: Record<BookmarkOutcome, number> = { retained: 0, proven: 0, unread: 0 };
    for (const identity of identities) {
      const key = identityKey(spec, identity);
      const previous = accepted.get(key) ?? { row: null, snapshot: null };
      const staged = stagedBookmarks.get(key) ?? { row: null, snapshot: null };
      const sameParser = !previous.row || !staged.row
        || spec.bookmarkParser.every(column => previous.row![column] === staged.row![column]);
      if (hasReadBookmark(sqlite, spec, previous) && sameParser
        && acceptedFacts.get(key) === finalFacts.get(key)) {
        writeBookmarkState(sqlite, spec, identity, previous);
        tally.retained++;
        continue;
      }
      if (!reparsePlan.partialIdentities.has(key)
        && hasReadBookmark(stage, spec, staged)
        && stagedFacts.byIdentity.get(key) === finalFacts.get(key)) {
        tally.proven++;
        continue;
      }
      if (!reparsePlan.partialIdentities.has(key)) continue;
      if (reparsePlan.selection) throw new Error(`Account rebuild has no complete-source reading proof for ${key}; publication was rolled back`);
      const marker = unreadBookmark(spec,
        staged.row || staged.snapshot ? staged : previous, nullableColumns);
      if (marker) writeBookmarkState(sqlite, spec, identity, marker);
      tally.unread++;
    }
    const prior = outcome.diagnostics.reparse && typeof outcome.diagnostics.reparse === "object"
      ? outcome.diagnostics.reparse as Record<string, unknown> : {};
    outcome.diagnostics = { ...outcome.diagnostics, reparse: { ...prior, bookmarks: tally,
      bookmarkPolicy: tally.unread > 0
        ? "partial-publication-marked-unread; next ordinary sync performs an explicit full-source correction"
        : "complete-source-proof" } };
  };
  const publish = () => publishIncrementalDelta(
    sqlite,
    stage,
    outcome.vendor,
    identities,
    changedIdentities,
    (impact) => {
      // Invalidation triggers removed changed proofs. Read only those identities,
      // then persist acceptance together with facts, bookmarks and the receipt.
      saveAcceptedFacts(sqlite, outcome.vendor,
        vendorIdentityFingerprints(sqlite, outcome.vendor, identities, true, true));
      // A bounded publication either restores a proven whole-source bookmark
      // or records an honest unread position before source success is published.
      resolveRangedBookmarks();
      // Clear an offline warning only after that source was successfully published.
      if(!reparsePlan && priorReparse && typeof priorReparse==="object" && "unavailable" in priorReparse && Array.isArray(priorReparse.unavailable)) {
        const published=new Set(identities.map(identity=>identityKey(DELTA_SPECS[outcome.vendor],identity)));
        outcome.diagnostics.reparse={...priorReparse,unavailable:priorReparse.unavailable.filter(identity=>
          !published.has(identityKey(DELTA_SPECS[outcome.vendor],identity)))};
      }
      outcome.sourceImpact = impact.finish();
      recordProjectRules();
      if (outcome.dataChanged) {
        options.afterPublishBeforeRevision?.();
        result.afterRevisions = store.advanceDataInTransaction(outcome.vendor, now());
        result.aggregateWorkRequested = true;
        publicationState.affected.set(outcome.vendor, changedIdentities);
      } else {
        result.afterRevisions = store.revisions();
      }
      outcome.status = "success";
      outcome.finishedAt = now();
      saveCompletedSourceBookmark();
      saveRun(result);
    }
    , () => {
      const currentFacts = vendorIdentityFingerprints(sqlite, outcome.vendor, identities, true, true).byIdentity;
      if (identities.some(identity => {
        const key = identityKey(spec, identity);
        return currentFacts.get(key) !== activeFacts.byIdentity.get(key);
      })) throw new Error("Accepted source facts changed after comparison; retry publication");
      saveAcceptedFacts(sqlite, outcome.vendor, {
        ...activeFacts, byIdentity: currentFacts,
      });
      if (reparsePlan?.selection) {
        const current = vendorIdentityFingerprints(sqlite, outcome.vendor, identities).byIdentity;
        if (!accountAccepted || identities.some(identity => {
          const key=identityKey(spec,identity);
          return current.get(key)!==accountAccepted!.get(key);
        }) || JSON.stringify(accountOwners)!==JSON.stringify(accountOwnerEvidence()))
          throw new Error("Account source facts changed after scope verification; no source facts were published. Retry this generation.");
      }
      if (bounded) {
        accepted = new Map(identities.map(identity =>
          [identityKey(spec, identity), readBookmarkState(sqlite, spec, identity)]));
        acceptedFacts = currentFacts;
      }
    }, bounded || queuedFiles || ROW_DIFF_VENDORS.has(outcome.vendor),
    publicationProgress.report);
  finishComparison();
  options.beforeIncrementalPublish?.();
  const publicationStarted = timingStart();
  try { publish(); }
  finally { timingEnd("publicationMs", publicationStarted); }
}
