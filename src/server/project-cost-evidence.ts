import type { ClaudeProjectEvidenceReason } from "./claude-project-usage";
import type { ProviderProjectEvidenceReason } from "./provider-project-usage";

export type AccountEvidence = {
  vendor: string;
  reason: ClaudeProjectEvidenceReason | ProviderProjectEvidenceReason;
  tokens: number;
  calls: number;
};

const ACCOUNT_EVIDENCE_NOTES: Record<AccountEvidence["reason"], string> = {
  unverified_account: "brak potwierdzonego konta w zrodle",
  source_without_identity: "zrodlo nie ma danych potrzebnych do potwierdzenia wlasciciela",
  unmapped_account: "zapisany alias zrodla nie nalezy do zadnej zadeklarowanej ery",
  ambiguous_account: "zapisany alias zrodla pasuje do wiecej niz jednego konta",
};

export function accountEvidenceNote(items: AccountEvidence[]): string {
  return items.map((item) => `${item.vendor}: ${ACCOUNT_EVIDENCE_NOTES[item.reason]} ` +
    `(${item.tokens} tok., ${item.calls} wyw.); ruch pozostaje bez ceny i bez przypisania.`).join(" ");
}

export type ConflictEvidence = { provider: string; account: string; identities: number };

/** Account-wide evidence: conflicting copies can disagree on date and subject. */
export function conflictNote(conflicts: ConflictEvidence[]): string {
  return `Sprzeczne kopie tego samego wywolania, wykluczone z sum - ${conflicts
    .map((item) => `${item.provider}/${item.account} (${item.identities} tozsam.)`)
    .join(", ")}. Liczba dotyczy calego konta i wybranego zakresu, nie wybranego projektu. ` +
    "Tokeny i kwoty sa NIEZNANE: nie wybieramy zadnej kopii, nie sumujemy kopii i nie wpisujemy zera.";
}
