import type { VendorId } from "./contracts";
import type { FactsSpec } from "./accepted-facts";
import type { Database } from "../db/sqlite";
import { identityFacts } from "./accepted-facts";

interface VendorTables {
  data: string[];
  evidence?: string[];
  publish: string[];
  order: Record<string, string[]>;
}

export const VENDOR_TABLES: Record<VendorId, VendorTables> = {
  codex: {
    data: ["events", "ratelimit"],
    evidence: ["codex_file_evidence"],
    publish: ["events", "ratelimit", "codex_file_evidence", "files"],
    order: {
      events: ["home", "path", "ts", "surface", "model", "effort"],
      ratelimit: ["home", "path", "ts", "window_minutes", "limit_id"],
      codex_file_evidence: ["home", "path"],
    },
  },
  claude: {
    data: ["claude_events", "claude_limit_hits"],
    publish: ["claude_events", "claude_limit_hits", "claude_files"],
    order: { claude_events: ["store", "call_id"], claude_limit_hits: ["store", "call_id"] },
  },
  opencode: {
    data: ["oc_events"],
    publish: ["oc_events"],
    order: { oc_events: ["store", "message_id"] },
  },
  grok: {
    data: ["grok_events"],
    publish: ["grok_events", "grok_files"],
    order: { grok_events: ["store", "source_id", "session_id", "prompt_id", "model"] },
  },
  gemini: {
    data: ["gemini_events"],
    publish: ["gemini_events", "gemini_files"],
    order: { gemini_events: ["store", "conversation_id", "gen_idx"] },
  },
  gauges: {
    data: ["probe_windows", "gauge_journal_receipts"],
    publish: ["probe_windows", "gauge_files", "gauge_journal_receipts"],
    order: {
      probe_windows: ["provider", "ts", "machine", "kind", "limit_group", "scope", "profile"],
      gauge_journal_receipts: ["entry_id"],
    },
  },
};

/** Source proof affects freshness/correspondence, while timestamp and usage contracts remain separate. */
export const vendorSourceTables = (vendor: VendorId) => [...VENDOR_TABLES[vendor].data, ...(VENDOR_TABLES[vendor].evidence ?? [])];

// Append-only vendors: the live table is also written locally (probe cycles),
// so publishing must add rows, never delete-and-reinsert by identity.
export const APPEND_VENDORS: ReadonlySet<VendorId> = new Set<VendorId>(["gauges"]);

// These vendors stage every row of each changed identity, so publication can keep the
// rows that did not change instead of deleting and reinserting the whole identity.
// Preserving them keeps their rowid, and with it the change-log volume proportional to
// the real edit and every rowid-derived key stable across runs.
// Claude is excluded: it publishes per `call_id` through its own merge path.
export const ROW_DIFF_VENDORS: ReadonlySet<VendorId> = new Set<VendorId>(["codex", "grok", "gemini", "opencode"]);

export type DeltaIdentity = Record<string, string | number>;

export interface DeltaSpec {
  identity: string[];
  bookmarkTable: string | null;
  bookmarkCompare: string[];
  // How far a read of this source got. Cleared together with the fingerprint when
  // no read can be shown to have reached any position at all.
  bookmarkProgress: string[];
  // Parser identity and resume context. A bookmark from an earlier parser cannot
  // witness the facts a later parser produced, so retention requires equality.
  bookmarkParser: string[];
}

export const DELTA_SPECS: Record<VendorId, DeltaSpec> = {
  // `parser_state` carries the resume context, including the byte offset, so it is
  // part of the position and not of the parser's identity.
  codex: { identity: ["home", "path"], bookmarkTable: "files", bookmarkCompare: ["size", "mtime", "parser_version", "parser_state"], bookmarkProgress: ["offset", "events", "parser_state"], bookmarkParser: ["parser_version"] },
  claude: { identity: ["store", "path"], bookmarkTable: "claude_files", bookmarkCompare: ["size", "mtime", "parser_version"], bookmarkProgress: ["calls"], bookmarkParser: ["parser_version"] },
  opencode: { identity: ["store"], bookmarkTable: null, bookmarkCompare: [], bookmarkProgress: [], bookmarkParser: [] },
  grok: { identity: ["store", "path"], bookmarkTable: "grok_files", bookmarkCompare: ["size", "mtime", "source_id"], bookmarkProgress: ["turns"], bookmarkParser: [] },
  gemini: { identity: ["store", "path"], bookmarkTable: "gemini_files", bookmarkCompare: ["size", "mtime", "generations"], bookmarkProgress: ["generations"], bookmarkParser: [] },
  // Only the bookmark copy into the stage is used; append vendors never go
  // through identity deltas.
  gauges: { identity: ["store", "path"], bookmarkTable: "gauge_files", bookmarkCompare: ["size", "mtime", "offset"], bookmarkProgress: ["offset", "rows"], bookmarkParser: [] },
};

function vendorFactsSpec(vendor: VendorId, includeEvidence = true): FactsSpec {
  return { identity: DELTA_SPECS[vendor].identity,
    tables: (includeEvidence ? vendorSourceTables(vendor) : VENDOR_TABLES[vendor].data)
      .map(table => ({ table, order: VENDOR_TABLES[vendor].order[table] })) };
}

export function acceptedFactsSpecs(): Record<string, FactsSpec> {
  return Object.fromEntries((["codex", "claude", "gemini", "grok", "opencode"] as const)
    .map(vendor => [vendor, vendorFactsSpec(vendor)]));
}

export function vendorIdentityFingerprints(sqlite: Database, vendor: VendorId, identities: DeltaIdentity[], includeEvidence = true, accepted = false) {
  return identityFacts(sqlite, vendor, vendorFactsSpec(vendor, includeEvidence), identities, accepted);
}
