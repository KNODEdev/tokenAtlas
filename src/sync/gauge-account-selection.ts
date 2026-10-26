import type { Database } from "bun:sqlite";
import {
  validateCanonicalProbe,
  type CanonicalProbe,
  type ProbePublicationRange,
} from "../db/probe-facts";
import {
  normalizeRebuildAccounts,
  type RebuildAccount,
} from "../shared/rebuild-accounts";
import type { AccountResolver } from "../server/account-resolver";
import { probeArchiveSourceOf, type ProbeSourceOptions } from "../server/probe-source";
import { USAGE_VENDOR_IDS, type UsageVendorId } from "./contracts";

type PublicationDay = {
  vendor: UsageVendorId;
  account: string;
  day: string;
};

type StagedCounterRow = {
  counter_id: string;
  replay_ts: string;
  observation_id: string;
  discriminator: string;
  payload: string;
  payload_digest: string;
  header: string;
};

type SelectedCounter = {
  fact: CanonicalProbe;
  replayTs: string;
  vendor: UsageVendorId;
  account: string;
};

function providerVendor(provider: string): UsageVendorId {
  switch (provider) {
    case "glm":
      return "opencode";
    case "codex":
    case "claude":
    case "opencode":
    case "grok":
    case "gemini":
      return provider;
    default:
      throw new Error(`Unknown gauge provider: ${provider}`);
  }
}

export function restrictGaugeAccountPublication(
  active: Database,
  accounts: readonly RebuildAccount[],
  evidence: ProbeSourceOptions & { resolver: AccountResolver },
  range?: ProbePublicationRange,
): {
  days: PublicationDay[];
  selectedCounters: number;
} {
  if (!active.inTransaction) {
    throw new Error("Gauge account publication requires the main transaction");
  }
  if (!active.query(
    "SELECT 1 FROM sync_stage.sqlite_master WHERE type='table' AND name='gauge_replay_counters'",
  ).get()) {
    throw new Error("Gauge replay counter selection is unavailable");
  }

  const normalized = normalizeRebuildAccounts(accounts);
  const requested = new Set(
    normalized.map(({ vendor, account }) => JSON.stringify([vendor, account])),
  );
  const requestedVendors = new Set(normalized.map(({ vendor }) => vendor));

  const dangling = active.query(`
    SELECT r.counter_id
    FROM sync_stage.gauge_replay_counters r
    LEFT JOIN sync_stage.probe_counters c ON c.id=r.counter_id
    LEFT JOIN sync_stage.probe_observations o ON o.id=c.observation_id
    WHERE c.id IS NULL OR o.id IS NULL
    LIMIT 1
  `).get() as { counter_id: string } | null;
  if (dangling) {
    throw new Error(`Gauge replay counter has no canonical fact: ${dangling.counter_id}`);
  }

  const candidates = active.query(`
    SELECT
      r.counter_id,
      r.ts AS replay_ts,
      c.observation_id,
      c.discriminator,
      c.payload,
      c.payload_digest,
      o.header
    FROM sync_stage.gauge_replay_counters r
    JOIN sync_stage.probe_counters c ON c.id=r.counter_id
    JOIN sync_stage.probe_observations o ON o.id=c.observation_id
    ORDER BY r.counter_id
  `).all() as StagedCounterRow[];

  // Resolve and validate every candidate before changing any staged table.
  const selected: SelectedCounter[] = [];
  for (const row of candidates) {
    const fact = validateCanonicalProbe({
      version: 1,
      observation_id: row.observation_id,
      counter_id: row.counter_id,
      header: JSON.parse(row.header),
      discriminator: JSON.parse(row.discriminator),
      payload: JSON.parse(row.payload),
      payload_digest: row.payload_digest,
    });
    if (row.replay_ts !== fact.header.ts) {
      throw new Error("Gauge replay timestamp does not match canonical probe");
    }

    const vendor = providerVendor(fact.header.provider);
    if (!requestedVendors.has(vendor)) continue;

    const at = Date.parse(fact.header.ts);
    if (!Number.isFinite(at)) {
      throw new Error("Invalid canonical gauge timestamp");
    }
    if ((range?.from && at < Date.parse(range.from))
      || (range?.untilExclusive && at >= Date.parse(range.untilExclusive))) continue;

    const source = probeArchiveSourceOf({ ...fact.payload, provider: fact.header.provider }, evidence);
    if (!source) {
      throw new Error(`Gauge account ownership cannot be proven for ${fact.counter_id}: physical source is missing or ambiguous; accepted facts were kept`);
    }
    const ownership = evidence.resolver.resolve(fact.header.provider, source, null, fact.header.ts);
    if (ownership.basis === "no-source") {
      throw new Error(`Gauge account ownership cannot be proven for ${fact.counter_id}; accepted facts were kept`);
    }
    const account = ownership.account;
    if (!account || !requested.has(JSON.stringify([vendor, account]))) continue;
    selected.push({
      fact,
      replayTs: row.replay_ts,
      vendor,
      account,
    });
  }

  active.exec("DELETE FROM sync_stage.gauge_replay_counters");
  using insertReplay = active.prepare(
    "INSERT INTO sync_stage.gauge_replay_counters(counter_id,ts) VALUES (?,?)",
  );
  for (const item of selected) {
    insertReplay.run(item.fact.counter_id, item.replayTs);
  }

  active.exec("DELETE FROM sync_stage.probe_windows");
  for (const item of selected) {
    const projection: Record<string, string | number | null> = {
      ...item.fact.payload,
    };
    const columns = Object.keys(projection).filter(
      key => !["raw_subject", "login", "source_home"].includes(key),
    );
    active.query(`
      INSERT OR IGNORE INTO sync_stage.probe_windows (${columns.join(",")})
      VALUES (${columns.map(() => "?").join(",")})
    `).run(...columns.map(column => projection[column]!));
  }

  active.exec("DELETE FROM sync_stage.gauge_journal_receipts");
  active.exec("DELETE FROM sync_stage.gauge_files");

  const uniqueDays = new Map<string, PublicationDay>();
  for (const item of selected) {
    const day = new Date(item.fact.header.ts).toISOString().slice(0, 10);
    const value = { vendor: item.vendor, account: item.account, day };
    uniqueDays.set(JSON.stringify([value.vendor, value.account, value.day]), value);
  }
  const days = [...uniqueDays.values()].sort((left, right) =>
    USAGE_VENDOR_IDS.indexOf(left.vendor) - USAGE_VENDOR_IDS.indexOf(right.vendor)
      || left.account.localeCompare(right.account)
      || left.day.localeCompare(right.day),
  );
  return { days, selectedCounters: selected.length };
}
