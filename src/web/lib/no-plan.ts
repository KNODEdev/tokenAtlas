import { isNoPlan } from "../../shared/period-end";
import { translate } from "./i18n";

/** The reserved plan-period value (`none`) in the reader's language. */
export const noPlanLabel = (): string => translate("No subscription", "Brak abonamentu");

/**
 * A plan text as the server sends it — one plan or a chain like "max-20x → none" — with the reserved
 * value in words. Every other plan name is left exactly as it was.
 */
export function planText(value: string): string;
export function planText(value: string | null | undefined): string | null;
export function planText(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (!value.includes("none")) return value;
  return value.split(" → ").map((part) => isNoPlan(part.trim()) ? noPlanLabel() : part).join(" → ");
}
