/**
 * Contract of `/api/account-periods`: the account and plan periods of
 * docs/account-periods-model-2026-09-21.md as the Settings card shows and edits them.
 *
 * Dates are ISO instants, or YYYY-MM-DD meaning that day's UTC midnight; `from` inclusive,
 * `until` exclusive and null while the period continues. Observed rows come from probe readings
 * and are never edited here; an edit writes a declared row to `config/account-periods.json` in
 * the archive, and a declared row wins over observed ones inside its range.
 */
export type PeriodOrigin = "observed" | "declared";

interface PeriodRowBase {
  id: number;
  provider: string;
  from: string;
  until: string | null;
  origin: PeriodOrigin;
  /** Observed rows: the first and last reading behind the row and how many there were. */
  firstSeen: string | null;
  lastSeen: string | null;
  readings: number;
  /** What the row rests on: `profile-reading`, a receipt, the owner's statement. */
  evidence: string;
  /** Declared rows only: the owner's free-text note from the declarations file. */
  note: string | null;
}
/** "At source S, from–until, account A was signed in." `source` is an archive folder such as `claude/example-main`. */
export interface AccountPeriodRow extends PeriodRowBase { source: string; account: string }
/** "Account A, from–until, had plan P." `plan` is the provider's own label or the plan catalog spelling. */
export interface PlanPeriodRow extends PeriodRowBase {
  account: string; plan: string; amountMinor: number | null; currency: string | null;
  /** The plan catalog's name and capacity multiplier on the row's start day; null when the catalog has no such plan. */
  tier?: { label: string; multiplier: number | null } | null;
  /** Declared rows: the renewal instant the billing cycles count from (null: `from`) and the cycle length in months (null: 1). */
  anchor?: string | null;
  cycleMonths?: number | null;
}

/** One archive folder = one profile on one computer; the subject of account periods. */
export interface PeriodSource {
  provider: string;
  /** Lower-case archive folder, e.g. `codex/example-main-sample_b`. */
  key: string;
  /** Computer and local profile directory when known (`EXAMPLE-MAIN`, `.codex-2`). */
  machine: string | null;
  profile: string | null;
  /** Range of recorded events in this folder (from the ledgers), null when none are indexed or the ledgers are preparing. */
  events: { first: string; last: string; calls: number } | null;
}
export interface PeriodAccount {
  provider: string;
  id: string;
  /** E-mail when known, otherwise the identifier. */
  label: string;
  /** Signed in on this computer right now. */
  current: boolean;
}

export interface AccountPeriodsView {
  /** Digest of the declarations file; every edit must quote it (optimistic concurrency). */
  revision: string;
  sources: PeriodSource[];
  accounts: PeriodAccount[];
  accountPeriods: AccountPeriodRow[];
  planPeriods: PlanPeriodRow[];
  declarations: {
    /** Archive path of `account-periods.json`. */
    file: string;
    present: boolean;
    /** A file with errors declares nothing; the rows of the previous good version stay. */
    errors: string[];
  };
}

export interface AccountDeclarationInput {
  provider: string;
  source: string;
  account: string;
  from: string;
  until: string | null;
  evidence: string;
  note?: string | null;
}
export interface PlanDeclarationInput {
  provider: string;
  account: string;
  plan: string;
  from: string;
  until: string | null;
  evidence: string;
  note?: string | null;
  amount_minor?: number | null;
  currency?: string | null;
  /** The renewal instant the billing cycles count from; empty or null: `from`. */
  anchor?: string | null;
  /** 1 (monthly, also null) or 12 (annual). */
  cycle_months?: number | null;
}
/**
 * One change of the declarations file. `replace` names the declared row being edited or removed
 * by its unique key; `row` is the new content, or null to remove. A new row has no `replace`.
 */
export type PeriodEdit =
  | { revision: string; kind: "account"; replace?: { source: string; from: string } | null; row: AccountDeclarationInput | null; preview?: boolean; end_earlier?: boolean }
  | { revision: string; kind: "plan"; replace?: { account: string; from: string } | null; row: PlanDeclarationInput | null; preview?: boolean; end_earlier?: boolean };
/*
 * `end_earlier`: declared rows of the same subject that start before the new row and still run at
 * its start end there, in the same save. It is how one plan or account follows another; a row that
 * starts inside the new range is never shortened or removed this way.
 */

/** What a save would touch, shown before it happens. */
export interface PeriodEditPreview {
  /** Account edits: recorded events of the source inside the row's range (ledger day sums), null while the ledgers are preparing. */
  events: { calls: number; days: number; first: string | null; last: string | null } | null;
  /** Observed rows the new declared row overrides inside its range and disagrees with. */
  overrides: Array<{ id: number; from: string; until: string | null; value: string }>;
  /** Validation errors the file would have after the edit; the save is refused while any exist. */
  errors: string[];
  /**
   * Earlier declared rows that `end_earlier` ends at the new row's start (`until` is their current
   * end), and the file's errors once they are ended. Null when no earlier row runs into the new one.
   */
  endEarlier?: { rows: Array<{ value: string; from: string; until: string | null }>; errors: string[] } | null;
  /**
   * Plan edits: the only billing cycles the save recomputes, those of this account from `from` on
   * (docs/billing-cycles-design-2026-10-08.md §8). Window sums, valuations and other accounts are not touched.
   */
  billing?: { provider: string; account: string; from: string } | null;
}
export interface PeriodEditResult {
  preview: PeriodEditPreview;
  /** False when the tables could not be updated right away (a writer held the database); the 60 s feed catches up. */
  applied: boolean;
  view: AccountPeriodsView;
}
