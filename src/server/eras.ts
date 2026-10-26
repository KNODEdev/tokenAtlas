import { createHash } from "crypto";

/**
 * An era is a dated view of an account's physical source. Runtime entries are
 * derived from account_periods; frozen tests can supply historical declarations.
 * `from` is inclusive and `until` exclusive.
 */
export interface EraDeclaration {
  id: string;
  vendor?: string;
  machine?: string;
  account_key?: string;
  /** Previous labels used by this source's identity-free meter journal. */
  probe_subjects?: string[];
  home?: string | null;
  source_home?: string | null;
  account?: string | null;
  from?: string;
  until?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function eraDay(ts: string): string {
  return String(ts ?? "").slice(0, 10);
}

export function normEraKey(raw: string | null | undefined): string {
  return String(raw ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function normEraVendor(vendor: string | null | undefined): string {
  const v = String(vendor ?? "").trim().toLowerCase() || "codex";
  return v === "anthropic" ? "claude" : v;
}

export function eraCovers(era: { from?: string; until?: string }, ts: string): boolean {
  const day = eraDay(ts);
  if (!day) return false;
  if (era.from && day < era.from) return false;
  if (era.until && day >= era.until) return false;
  return true;
}

function eraLabel(era: EraDeclaration): string {
  const from = era.from ?? "-inf";
  const until = era.until ?? "+inf";
  return `${era.id} [${from}, ${until})`;
}

function overlaps(a: EraDeclaration, b: EraDeclaration): boolean {
  // Half-open intervals overlap unless one ends at or before the other starts.
  if (a.until && b.from && a.until <= b.from) return false;
  if (b.until && a.from && b.until <= a.from) return false;
  return true;
}

/** Every key a source can be named by: its homes, plus the subscription id for
 *  vendors that report a store or id instead of a path (grok, glm, gemini). */
function eraKeys(era: EraDeclaration): string[] {
  const keys = new Set<string>();
  for (const raw of [era.home, era.source_home, era.id]) {
    const k = normEraKey(raw);
    if (k) keys.add(k);
  }
  return [...keys];
}

function homeKeys(era: EraDeclaration): string[] {
  const keys = new Set<string>();
  for (const raw of [era.home, era.source_home]) {
    const k = normEraKey(raw);
    if (k) keys.add(k);
  }
  return [...keys];
}

/**
 * Overlap of two eras of the SAME home is a rejected declaration; distinct
 * homes overlap freely, because parallel subscriptions are the supported shape.
 * Matching subscription ids do not relax this rule because their declarations
 * can still carry conflicting vendor accounts.
 */
export function validateEras(subscriptions: EraDeclaration[]): string[] {
  const errors: string[] = [];
  for (const era of subscriptions) {
    for (const [field, value] of [["from", era.from], ["until", era.until]] as const) {
      if (value !== undefined && !DATE_RE.test(value)) {
        errors.push(`subskrypcja '${era.id}': '${field}' = '${value}' nie jest datą YYYY-MM-DD`);
      }
    }
    if (era.from && era.until && DATE_RE.test(era.from) && DATE_RE.test(era.until) && era.until <= era.from) {
      errors.push(`subskrypcja '${era.id}': era kończy się (${era.until}) nie później niż zaczyna (${era.from})`);
    }
  }
  const byHome = new Map<string, EraDeclaration[]>();
  for (const era of subscriptions) {
    for (const key of homeKeys(era)) {
      const bucket = `${normEraVendor(era.vendor)}|${key}`;
      const list = byHome.get(bucket) ?? [];
      list.push(era);
      byHome.set(bucket, list);
    }
  }
  for (const [bucket, list] of byHome) {
    const home = bucket.slice(bucket.indexOf("|") + 1);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        const local = home === normEraKey(a.source_home) && home === normEraKey(b.source_home)
          && home !== normEraKey(a.home) && home !== normEraKey(b.home);
        if (local && a.machine && b.machine && normEraKey(a.machine) !== normEraKey(b.machine)) continue;
        if (!overlaps(a, b)) continue;
        errors.push(
          `home '${home}' jest w dwóch nakładających się erach: ${eraLabel(a)} oraz ${eraLabel(b)} — ` +
            `domknij jedną z nich (until wyłącznie) albo rozdziel home`
        );
      }
    }
  }
  return errors;
}

export interface EraIndex {
  fingerprint?: string;
  /**
   * The subscription that owned this source at `ts`, or null when no era covers
   * it or two eras of different subscriptions do. Never falls through to the
   * latest era: an unattributable row stays unattributed.
   */
  resolve(vendor: string, source: string, ts: string, machine?: string | null): string | null;
  resolveDetailed(vendor: string, source: string, ts: string, machine?: string | null): EraResolution;
  /** Eras registered under a source key, in declaration order. */
  erasFor(vendor: string, source: string, machine?: string | null): EraDeclaration[];
  /** Entries declaring this subscription id, in declaration order. */
  entriesOf(id: string): EraDeclaration[];
  /** Entries whose era covers `ts` — what a caller that means "now" wants. */
  activeAt(ts: string): EraDeclaration[];
}

export interface EraResolution {
  subscription_id: string | null;
  reason: "source-not-declared" | "outside-declared-era" | "ambiguous-era" | null;
}

export function buildEraIndex(subscriptions: EraDeclaration[], precision: "day" | "instant" = "day"): EraIndex {
  const covers = precision === "day" ? eraCovers : (era: EraDeclaration, ts: string): boolean => {
    const time = Date.parse(ts);
    if (!Number.isFinite(time)) return false;
    return (!era.from || Date.parse(era.from) <= time) && (!era.until || time < Date.parse(era.until));
  };
  const bySource = new Map<string, EraDeclaration[]>();
  const byId = new Map<string, EraDeclaration[]>();
  for (const era of subscriptions) {
    if (!era.id) continue;
    for (const key of eraKeys(era)) {
      const bucket = `${normEraVendor(era.vendor)}|${key}`;
      const list = bySource.get(bucket) ?? [];
      list.push(era);
      bySource.set(bucket, list);
    }
    for (const id of new Set([era.id, ...(era.probe_subjects ?? [])])) {
      const idKey = id.toLowerCase();
      const list = byId.get(idKey) ?? [];
      list.push(era);
      byId.set(idKey, list);
    }
  }
  const lookup = (vendor: string, source: string, machine?: string | null): EraDeclaration[] =>
    (bySource.get(`${normEraVendor(vendor)}|${normEraKey(source)}`) ?? [])
      .filter(era => !machine || !era.machine || normEraKey(era.machine) === normEraKey(machine));
  const resolveDetailed = (vendor: string, source: string, ts: string, machine?: string | null): EraResolution => {
    const declared = lookup(vendor, source, machine);
    if (declared.length === 0) {
      return { subscription_id: null, reason: "source-not-declared" };
    }
    const covering = declared.filter((era) => covers(era, ts));
    if (covering.length === 0) {
      return { subscription_id: null, reason: "outside-declared-era" };
    }
    const ids = new Set(covering.map((era) => era.id.toLowerCase()));
    if (ids.size !== 1) {
      return { subscription_id: null, reason: "ambiguous-era" };
    }
    return { subscription_id: covering[0]!.id, reason: null };
  };
  return {
    fingerprint: eraFingerprint(subscriptions),
    resolve(vendor, source, ts, machine) {
      return resolveDetailed(vendor, source, ts, machine).subscription_id;
    },
    resolveDetailed,
    erasFor: (vendor, source, machine) => lookup(vendor, source, machine),
    entriesOf: (id) => byId.get(String(id ?? "").toLowerCase()) ?? [],
    activeAt: (ts) => subscriptions.filter((era) => covers(era, ts)),
  };
}

/**
 * A subscription is inactive once every one of its eras is closed, and "closed"
 * means `until` is set — not that the date has passed. The rule is declarative
 * on purpose (domain note: „wszystkie jej Ery zamknięte (`until` ustawione) …
 * czysto deklaratywna"), so a card does not leave the active section on its own
 * the moment a clock ticks past a boundary. An undeclared id is active.
 */
export function isSubscriptionActive(subscriptions: EraDeclaration[], id: string): boolean {
  const entries = subscriptions.filter((era) => era.id.toLowerCase() === String(id ?? "").toLowerCase());
  if (entries.length === 0) return true;
  return entries.some((era) => !era.until);
}

/** The vendor account declared for a subscription: the era covering `now` wins,
 *  otherwise the last era that declared one. */
export function declaredVendorAccount(
  subscriptions: EraDeclaration[],
  id: string,
  now: string = new Date().toISOString()
): string | null {
  const entries = subscriptions.filter((era) => era.id.toLowerCase() === String(id ?? "").toLowerCase());
  const current = entries.find((era) => eraCovers(era, now) && (era.account ?? "").trim());
  if (current) return current.account!.trim();
  for (let i = entries.length - 1; i >= 0; i--) {
    const account = (entries[i]!.account ?? "").trim();
    if (account) return account;
  }
  return null;
}

/** Stamp of the era declarations for memo and response configurations; nothing stores it. */
export function eraFingerprint(subscriptions: EraDeclaration[]): string {
  const rows = subscriptions
    .map((era) =>
      [
        era.id.toLowerCase(),
        normEraVendor(era.vendor),
        normEraKey(era.home),
        normEraKey(era.source_home),
        normEraKey(era.machine),
        era.account_key ?? "",
        [...(era.probe_subjects ?? [])].map(normEraKey).sort().join(","),
        era.from ?? "",
        era.until ?? "",
      ].join("|")
    )
    .sort();
  return createHash("sha256").update(rows.join(";")).digest("hex").slice(0, 16);
}
