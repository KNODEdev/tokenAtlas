import fs from "node:fs";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { normEraVendor } from "./eras";
import { periodInstant, validatePeriods, type DatedPeriod } from "./account-periods";
import { ACCOUNT_PERIODS, PLAN_PERIODS, replaceDeclaredPeriods } from "../db/period-store";
import { NO_PLAN, isNoPlan, looksLikeNoPlan } from "../shared/period-end";

/**
 * The owner's dated statements about accounts and plans, kept in the archive next to
 * `accounts.json` because a rebuild needs them (`golden-rules.md` §2). Every row here becomes a
 * `declared` period; observed rows come from readings and never from this file.
 *
 * Dates are ISO instants, or YYYY-MM-DD meaning that day's UTC midnight; `from` inclusive, `until`
 * exclusive and null while the period continues. An open `until` on an account row overrides every
 * later reading of that source, so it is meant for a correction, not for a takeover of history.
 */
export const PERIOD_DECLARATIONS_FILE = "account-periods.json";

export interface PeriodDeclarationsFile {
  version: 1;
  accounts?: AccountDeclaration[];
  plans?: PlanDeclaration[];
}
interface DeclarationBase { provider: string; from: string; until?: string | null; evidence: string; note?: string }
/** `source` is the archive folder of one profile on one computer, e.g. `claude/EXAMPLE-MAIN`. */
export interface AccountDeclaration extends DeclarationBase { source: string; account: string }
/**
 * `amount_minor` is what the receipt says, in the currency's minor unit; both optional. `anchor` is the renewal instant the
 * billing cycles count from (default `from`); `cycle_months` is 1 (monthly, default) or 12 (annual); see
 * docs/billing-cycles-design-2026-10-08.md §8.
 */
export interface PlanDeclaration extends DeclarationBase {
  account: string; plan: string; amount_minor?: number | null; currency?: string | null; anchor?: string | null; cycle_months?: number | null;
}

export interface PeriodDeclarations { accounts: DatedPeriod[]; plans: DatedPeriod[]; errors: string[]; digest: string }

const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;

function declared(provider: string, subject: string, row: DeclarationBase, value: string): DatedPeriod {
  return { provider: normEraVendor(provider), subject, from: row.from, until: row.until ?? null, value, origin: "declared",
    firstSeen: null, lastSeen: null, readings: 0, evidence: row.evidence };
}

export function parsePeriodDeclarations(source: string): PeriodDeclarations {
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const result: PeriodDeclarations = { accounts: [], plans: [], errors: [], digest };
  let file: PeriodDeclarationsFile;
  try { file = JSON.parse(source) as PeriodDeclarationsFile; }
  catch (error) { result.errors.push(`nieprawidłowy JSON: ${(error as Error).message}`); return result; }
  if (!file || typeof file !== "object" || file.version !== 1) { result.errors.push("oczekiwano obiektu z \"version\": 1"); return result; }
  const rows = (name: string, list: unknown): Record<string, unknown>[] => {
    if (list === undefined) return [];
    if (!Array.isArray(list)) { result.errors.push(`"${name}" musi być listą`); return []; }
    return list.filter((row, index): row is Record<string, unknown> => {
      if (row && typeof row === "object") return true;
      result.errors.push(`${name}[${index}]: wiersz musi być obiektem`);
      return false;
    });
  };
  const base = (name: string, index: number, row: Record<string, unknown>): DeclarationBase | null => {
    const provider = text(row.provider), from = text(row.from), evidence = text(row.evidence);
    const missing = [!provider && "provider", !from && "from", !evidence && "evidence"].filter(Boolean);
    if (missing.length) { result.errors.push(`${name}[${index}]: brak pola ${missing.join(", ")}`); return null; }
    if (row.until !== undefined && row.until !== null && !text(row.until)) { result.errors.push(`${name}[${index}]: "until" musi być datą albo null`); return null; }
    return { provider: provider!, from: from!, until: text(row.until), evidence: evidence! };
  };
  rows("accounts", file.accounts).forEach((row, index) => {
    const head = base("accounts", index, row), source = text(row.source), account = text(row.account);
    if (!head) return;
    if (!source || !account) { result.errors.push(`accounts[${index}]: brak pola ${[!source && "source", !account && "account"].filter(Boolean).join(", ")}`); return; }
    result.accounts.push(declared(head.provider, source, head, account));
  });
  rows("plans", file.plans).forEach((row, index) => {
    const head = base("plans", index, row), account = text(row.account), plan = text(row.plan);
    if (!head) return;
    if (!account || !plan) { result.errors.push(`plans[${index}]: brak pola ${[!account && "account", !plan && "plan"].filter(Boolean).join(", ")}`); return; }
    const amount = row.amount_minor ?? null, currency = text(row.currency);
    if (amount !== null && !Number.isSafeInteger(amount)) { result.errors.push(`plans[${index}]: "amount_minor" musi być liczbą całkowitą (grosze/centy)`); return; }
    // The reserved "no subscription" value has one spelling and no payment.
    if (looksLikeNoPlan(plan) && !isNoPlan(plan)) { result.errors.push(`plans[${index}]: brak abonamentu zapisuje się dokładnie jako "${NO_PLAN}"`); return; }
    if (isNoPlan(plan) && amount !== null && amount !== 0) { result.errors.push(`plans[${index}]: okres "${NO_PLAN}" (brak abonamentu) nie może mieć kwoty płatności`); return; }
    if (row.anchor !== undefined && row.anchor !== null && !text(row.anchor)) { result.errors.push(`plans[${index}]: "anchor" musi być datą albo null`); return; }
    const anchor = text(row.anchor);
    if (anchor !== null) {
      try { periodInstant(anchor, "anchor"); }
      catch { result.errors.push(`plans[${index}]: nieprawidłowa data odnowienia "anchor": '${anchor}'`); return; }
    }
    const months = row.cycle_months ?? null;
    if (months !== null && months !== 1 && months !== 12) { result.errors.push(`plans[${index}]: "cycle_months" musi być 1 (miesięczny) albo 12 (roczny)`); return; }
    result.plans.push({ ...declared(head.provider, account, head, plan), amountMinor: amount as number | null, currency,
      ...(anchor !== null || months !== null ? { anchor, cycleMonths: months as number | null } : {}) });
  });
  if (!result.errors.length) result.errors.push(...validatePeriods(result.accounts), ...validatePeriods(result.plans));
  if (result.errors.length) { result.accounts = []; result.plans = []; }
  return result;
}

/** The declarations file, or null when the archive has none; a file with errors declares nothing. */
export function readPeriodDeclarations(file: string): PeriodDeclarations | null {
  if (!fs.existsSync(file)) return null;
  return parsePeriodDeclarations(fs.readFileSync(file, "utf8"));
}

export interface PeriodDeclarationsSync { digest: string | null; changed: boolean; errors: string[] }

/**
 * Brings the declared rows of both tables in line with the file. A missing file declares nothing
 * and clears declared rows; a file with errors is left as it is, so a typo cannot drop the rows
 * built from the previous good version.
 */
export function applyPeriodDeclarations(sqlite: Database, file: string): PeriodDeclarationsSync {
  const read = readPeriodDeclarations(file);
  if (read?.errors.length) return { digest: read.digest, changed: false, errors: read.errors };
  const changed = sqlite.transaction(() =>
    [replaceDeclaredPeriods(sqlite, ACCOUNT_PERIODS, read?.accounts ?? []), replaceDeclaredPeriods(sqlite, PLAN_PERIODS, read?.plans ?? [])]
      .some(Boolean)).immediate();
  return { digest: read?.digest ?? null, changed, errors: [] };
}
