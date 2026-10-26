import { currentPointBasis, type CurrentPointBasis } from "../../shared/current-point-basis";
import type { CycleView } from "./cycle";
import { dayTime, usd } from "./format";
import { translate } from "./i18n";

export { type CurrentPointBasis, currentPointBasis };
export { creditBasisOf } from "../../shared/current-point-basis";

export function pointBasisOfCycles(cycles: readonly CycleView[]): CurrentPointBasis | null {
  return currentPointBasis(cycles.map(cycle => cycle.raw));
}

export function pointBasisTitle(basis: CurrentPointBasis | null): string {
  if (!basis) return translate("No comparable prepared meter sample yet.", "Brak przygotowanego porównywalnego pomiaru licznika.");
  return translate("Current conversion: {0}–{1}, {2} pp; 1 pp ≈ {3}, 100% ≈ {4}. Same sample for point rate and credit conversion.",
    `Aktualna podstawa: ${dayTime(basis.start)}–${dayTime(basis.end)}, ${basis.percent} pp; 1 pp ≈ ${usd(basis.usd / 100)}, 100% ≈ ${usd(basis.usd)}. Ten sam pomiar dla kursu punktu i przeliczenia kredytów.`,
    [dayTime(basis.start), dayTime(basis.end), basis.percent, usd(basis.usd / 100), usd(basis.usd)])
    + (basis.contextUnavailable ? " " + translate("Context preview unavailable for this sample; showing stored prices.",
      "Podgląd kontekstu niedostępny dla tego pomiaru; pokazano zapisane ceny.") : "")
    + (basis.partial ? " " + translate("Incomplete pricing: capacity is a lower bound; credit equivalents are estimates of the priced mix.",
      "Niepełna wycena: pojemność jest dolną granicą; ekwiwalenty kredytów są szacunkiem dla wycenionego miksu.") : "");
}
