import type { ProjectCostCoverage } from "./api";

/** Conflict identities have no reliable quantity or subject; do not format them as tokens. */
export function projectConflictHint(
  conflict: ProjectCostCoverage["conflicting_usage"],
  t: (en: string, pl: string) => string,
): string {
  if (!conflict || conflict.identities <= 0) return "";
  return `${t("Excluded conflicting Claude call identities:", "Wykluczone sprzeczne tożsamości wywołań Claude:")} ${conflict.identities}. `
    + `${t("Their token count, price and project attribution are unknown.", "Ich liczba tokenów, cena i przypisanie do projektu są nieznane.")} `
    + `${t("Account fee allocation is unavailable for:", "Podział kosztu abonamentu jest niedostępny dla kont:")} ${conflict.accounts.map(row => row.account).join(", ")}. `
    + t("This evidence covers accounts and the selected period, not confirmed usage of this project.",
      "To dane o kontach i wybranym okresie, a nie potwierdzone zużycie tego projektu.");
}
